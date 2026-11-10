package clientcli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"

	"github.com/spf13/cobra"
)

func newFilesCmd(conn *connection) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "files",
		Aliases: []string{"file"},
		Short:   "move files in and out of a session",
		Long: "Works on the session files root: browser downloads, recordings, uploads and automation output.\n" +
			"Paths are the relativePath values of `aperture files list`. The session token is enough.",
	}
	cmd.AddCommand(
		&cobra.Command{
			Use:   "list SESSION_ID",
			Short: "list a session's files and directories",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return conn.list(cmd, sessionPath(args[0], "/files"), nil, table{columns: []column{
					{"TYPE", "type"}, {"PATH", "relativePath"}, {"SIZE", "size"}, {"MODIFIED", "modifiedAt"},
				}})
			},
		},
		newFilesUploadCmd(conn),
		newFilesDownloadCmd(conn),
		newFilesURLCmd(conn),
		newFilesDeleteCmd(conn),
		&cobra.Command{
			Use:   "move SESSION_ID FROM TO",
			Short: "move or rename a file or directory",
			Args:  cobra.ExactArgs(3),
			RunE: func(cmd *cobra.Command, args []string) error {
				body := map[string]string{"from": args[1], "to": args[2]}
				return conn.run(cmd, http.MethodPost, sessionPath(args[0], "/files/move"), nil, body)
			},
		},
		&cobra.Command{
			Use:   "mkdir SESSION_ID PATH",
			Short: "create a directory with any missing parents",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				body := map[string]string{"relativePath": args[1]}
				return conn.run(cmd, http.MethodPost, sessionPath(args[0], "/files/directories"), nil, body)
			},
		},
	)
	return cmd
}

func newFilesUploadCmd(conn *connection) *cobra.Command {
	var directory string
	cmd := &cobra.Command{
		Use:   "upload SESSION_ID FILE...",
		Short: "store local files in the session",
		Long: "Uploads the files and prints where they landed. Names are sanitized and never overwrite:\n" +
			"an existing name gets a numeric suffix. The printed relativePath is what browser automation takes.",
		Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			files := args[1:]
			for _, file := range files {
				info, err := os.Stat(file)
				if err != nil {
					return err
				}
				if !info.Mode().IsRegular() {
					return fmt.Errorf("%s is not a regular file", file)
				}
			}

			reader, writer := io.Pipe()
			form := multipart.NewWriter(writer)
			go func() {
				writer.CloseWithError(writeFileParts(form, files))
			}()

			query := url.Values{}
			setIfPresent(query, "directory", directory)
			answer, err := conn.send(cmd.Context(), http.MethodPost, sessionPath(args[0], "/files"), query, form.FormDataContentType(), reader)
			_ = reader.Close()
			if err != nil {
				return err
			}
			return printJSON(cmd, answer)
		},
	}
	cmd.Flags().StringVar(&directory, "directory", "", "directory below the session files root (default: uploads)")
	return cmd
}

func writeFileParts(form *multipart.Writer, files []string) error {
	for _, file := range files {
		if err := writeFilePart(form, file); err != nil {
			return err
		}
	}
	return form.Close()
}

func writeFilePart(form *multipart.Writer, file string) error {
	source, err := os.Open(file)
	if err != nil {
		return err
	}
	defer func() { _ = source.Close() }()

	part, err := form.CreateFormFile("files", filepath.Base(file))
	if err != nil {
		return err
	}
	_, err = io.Copy(part, source)
	return err
}

// downloadURL asks the instance for a signed URL of one session file.
func downloadURL(cmd *cobra.Command, conn *connection, sessionID string, body map[string]any) (string, []byte, error) {
	answer, err := conn.call(cmd.Context(), http.MethodPost, sessionPath(sessionID, "/files/download-url"), nil, body)
	if err != nil {
		return "", nil, err
	}
	var signed struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(answer, &signed); err != nil || signed.URL == "" {
		return "", nil, errors.New("the instance returned no download url")
	}
	return signed.URL, answer, nil
}

func newFilesURLCmd(conn *connection) *cobra.Command {
	var (
		ttlSeconds int
		inline     bool
	)
	cmd := &cobra.Command{
		Use:   "url SESSION_ID PATH",
		Short: "create a signed download URL for a file",
		Long:  "Anyone with the URL can download the file until it expires.",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"relativePath": args[1]}
			if ttlSeconds > 0 {
				body["ttlSeconds"] = ttlSeconds
			}
			if inline {
				body["disposition"] = "inline"
			}
			_, answer, err := downloadURL(cmd, conn, args[0], body)
			if err != nil {
				return err
			}
			return printJSON(cmd, answer)
		},
	}
	cmd.Flags().IntVar(&ttlSeconds, "ttl", 0, "seconds until the URL expires (default: the instance's)")
	cmd.Flags().BoolVar(&inline, "inline", false, "let browsers display the file instead of downloading it")
	return cmd
}

func newFilesDownloadCmd(conn *connection) *cobra.Command {
	var output string
	cmd := &cobra.Command{
		Use:   "download SESSION_ID PATH",
		Short: "copy a session file to this machine",
		Long:  "Writes the file under its own name in the current directory, to --output, or to standard output with --output -.",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			signed, _, err := downloadURL(cmd, conn, args[0], map[string]any{"relativePath": args[1]})
			if err != nil {
				return err
			}

			req, err := http.NewRequestWithContext(cmd.Context(), http.MethodGet, signed, nil)
			if err != nil {
				return err
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				// The error text of a failed request carries the signed URL.
				var failed *url.Error
				if errors.As(err, &failed) {
					err = failed.Err
				}
				return fmt.Errorf("download: %w", err)
			}
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("download: http %d", resp.StatusCode)
			}

			if output == "-" {
				_, err := io.Copy(cmd.OutOrStdout(), resp.Body)
				return err
			}
			destination := output
			if destination == "" {
				// The name comes from the instance; keep only its last element
				// under either separator so it cannot leave the directory.
				destination = filepath.Base(filepath.FromSlash(path.Base(args[1])))
			}
			// A partial file next to the destination, with the mode a plain
			// create would give, so a failed download leaves an existing file intact.
			partial := fmt.Sprintf("%s.part-%d", destination, os.Getpid())
			target, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
			if err != nil {
				return err
			}
			written, err := io.Copy(target, resp.Body)
			if closeErr := target.Close(); err == nil {
				err = closeErr
			}
			if err == nil {
				err = os.Rename(target.Name(), destination)
			}
			if err != nil {
				_ = os.Remove(target.Name())
				return err
			}
			cmd.PrintErrf("%s (%d bytes)\n", destination, written)
			return nil
		},
	}
	cmd.Flags().StringVarP(&output, "output", "o", "", "destination file, or - for standard output")
	return cmd
}

func newFilesDeleteCmd(conn *connection) *cobra.Command {
	var recursive bool
	cmd := &cobra.Command{
		Use:   "delete SESSION_ID PATH",
		Short: "delete a file or directory",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			query := url.Values{"relativePath": {args[1]}}
			if recursive {
				query.Set("recursive", "true")
			}
			return conn.run(cmd, http.MethodDelete, sessionPath(args[0], "/files"), query, nil)
		},
	}
	cmd.Flags().BoolVarP(&recursive, "recursive", "r", false, "delete a directory together with everything below it")
	return cmd
}
