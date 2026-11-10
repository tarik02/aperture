package clientcli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

func newRecordingsCmd(conn *connection) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "recordings",
		Aliases: []string{"recording"},
		Short:   "record a session's tabs and direct the edited video",
	}
	cmd.AddCommand(
		&cobra.Command{
			Use:   "list SESSION_ID",
			Short: "list a session's recordings",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return conn.list(cmd, recordingPath(args[0], "", ""), nil, table{columns: []column{
					{"ID", "recordingId"}, {"STATUS", "status"}, {"EDITING", "editing"}, {"STARTED", "startedAt"},
					{"RAW", "relativePath"}, {"EDITED", "editedRelativePath"},
				}})
			},
		},
		&cobra.Command{
			Use:   "get SESSION_ID RECORDING_ID",
			Short: "show a recording and where its files are",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				return conn.run(cmd, http.MethodGet, recordingPath(args[0], args[1], ""), nil, nil)
			},
		},
		newRecordingsStartCmd(conn),
		newRecordingsStopCmd(conn),
		newRecordingsRetargetCmd(conn),
		newRecordingsCaptionCmd(conn),
		newRecordingsFocusCmd(conn),
		&cobra.Command{
			Use:   "reset-focus SESSION_ID RECORDING_ID",
			Short: "zoom the edited video back out",
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				return conn.run(cmd, http.MethodPost, recordingPath(args[0], args[1], "/reset-focus"), nil, nil)
			},
		},
		newRecordingsAttentionCmd(conn),
	)
	return cmd
}

func recordingPath(sessionID, recordingID, suffix string) string {
	path := sessionPath(sessionID, "/recordings")
	if recordingID != "" {
		path += "/" + url.PathEscape(recordingID)
	}
	return path + suffix
}

func newRecordingsStartCmd(conn *connection) *cobra.Command {
	var (
		target      string
		capture     string
		pace        string
		motion      string
		idle        string
		burst       string
		codec       string
		fps         int
		bitrateKbps int
		ripple      bool
	)
	cmd := &cobra.Command{
		Use:   "start SESSION_ID",
		Short: "start recording one tab",
		Long: "Starts a tab recording of one ready top-level target and returns once the first frame is captured.\n" +
			"Settings left out take the instance's defaults; contradictory ones are rejected before the session wakes.",
		Example: "  aperture recordings start 01a1… --target 4F2C… --capture bursts --burst tight",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"targetId": target}
			for key, value := range map[string]string{"capture": capture, "pace": pace, "motion": motion, "idle": idle, "codec": codec} {
				if value != "" {
					body[key] = value
				}
			}
			if burst != "" {
				body["burst"] = map[string]string{"preset": burst}
			}
			if fps > 0 {
				body["fps"] = fps
			}
			if bitrateKbps > 0 {
				body["bitrateKbps"] = bitrateKbps
			}
			if cmd.Flags().Changed("ripple") {
				body["ripple"] = ripple
			}
			return conn.run(cmd, http.MethodPost, recordingPath(args[0], "", ""), nil, body)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "ID of the ready top-level target to record")
	cmd.Flags().StringVar(&capture, "capture", "", "continuous, or bursts to keep only the stretches around automation")
	cmd.Flags().StringVar(&burst, "burst", "", "burst preset: tight, default or relaxed")
	cmd.Flags().StringVar(&pace, "pace", "", "how automation moves while recording: instant, fast or slow")
	cmd.Flags().StringVar(&motion, "motion", "", "pointer travel: linear or natural")
	cmd.Flags().StringVar(&idle, "idle", "", "what the edit does with idle stretches: cut or speed")
	cmd.Flags().BoolVar(&ripple, "ripple", false, "draw a ripple on clicks")
	cmd.Flags().StringVar(&codec, "codec", "", "vp8 or h264-va")
	cmd.Flags().IntVar(&fps, "fps", 0, "frame rate")
	cmd.Flags().IntVar(&bitrateKbps, "bitrate-kbps", 0, "bitrate in kbps")
	_ = cmd.MarkFlagRequired("target")
	return cmd
}

func newRecordingsStopCmd(conn *connection) *cobra.Command {
	var wait bool
	cmd := &cobra.Command{
		Use:   "stop SESSION_ID RECORDING_ID",
		Short: "stop a recording",
		Long: "Stops a recording and returns it at once: the raw video is published, and editing is true while\n" +
			"the edit runs, about as long as the recording. --wait returns the recording once the edit is done.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			answer, err := conn.call(cmd.Context(), http.MethodPost, recordingPath(args[0], args[1], "/stop"), nil, nil)
			if err != nil {
				return err
			}
			for wait {
				var recording struct {
					Editing bool `json:"editing"`
				}
				if err := json.Unmarshal(answer, &recording); err != nil {
					return fmt.Errorf("decode recording: %w", err)
				}
				if !recording.Editing {
					break
				}
				select {
				case <-cmd.Context().Done():
					return cmd.Context().Err()
				case <-time.After(2 * time.Second):
				}
				if answer, err = conn.call(cmd.Context(), http.MethodGet, recordingPath(args[0], args[1], ""), nil, nil); err != nil {
					return err
				}
			}
			return printJSON(cmd, answer)
		},
	}
	cmd.Flags().BoolVar(&wait, "wait", false, "wait until the edited video is ready")
	return cmd
}

func newRecordingsRetargetCmd(conn *connection) *cobra.Command {
	var target string
	cmd := &cobra.Command{
		Use:   "retarget SESSION_ID RECORDING_ID",
		Short: "move a running recording to another tab",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"targetId": target}
			return conn.run(cmd, http.MethodPost, recordingPath(args[0], args[1], "/retarget"), nil, body)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "ID of the ready top-level target to record from now on")
	_ = cmd.MarkFlagRequired("target")
	return cmd
}

func newRecordingsCaptionCmd(conn *connection) *cobra.Command {
	var durationMs int
	cmd := &cobra.Command{
		Use:   "caption SESSION_ID RECORDING_ID TEXT",
		Short: "show text in the edited video from now on",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"text": args[2]}
			if durationMs > 0 {
				body["durationMs"] = durationMs
			}
			return conn.run(cmd, http.MethodPost, recordingPath(args[0], args[1], "/caption"), nil, body)
		},
	}
	cmd.Flags().IntVar(&durationMs, "duration-ms", 0, "how long the caption stays (default: 3000)")
	return cmd
}

func newRecordingsFocusCmd(conn *connection) *cobra.Command {
	var (
		pointer    bool
		selector   string
		rect       string
		zoom       float64
		durationMs int
	)
	cmd := &cobra.Command{
		Use:   "focus SESSION_ID RECORDING_ID",
		Short: "zoom the edited video in on the pointer, an element or an area",
		Long: "Zooms the edited video in and holds it until reset-focus, or for --duration-ms.\n" +
			"Name exactly one of --pointer, --selector and --rect.",
		Example: "  aperture recordings focus 01a1… 01b2… --pointer --zoom 2",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			target := map[string]any{}
			if pointer {
				target["pointer"] = true
			}
			if selector != "" {
				target["selector"] = selector
			}
			if rect != "" {
				numbers, err := numberList("rect", rect, 4)
				if err != nil {
					return err
				}
				target["rect"] = map[string]float64{"x": numbers[0], "y": numbers[1], "width": numbers[2], "height": numbers[3]}
			}
			if len(target) != 1 {
				return errors.New("name exactly one of --pointer, --selector and --rect")
			}
			body := map[string]any{"target": target, "zoom": zoom}
			if durationMs > 0 {
				body["durationMs"] = durationMs
			}
			return conn.run(cmd, http.MethodPost, recordingPath(args[0], args[1], "/focus"), nil, body)
		},
	}
	cmd.Flags().BoolVar(&pointer, "pointer", false, "follow the pointer")
	cmd.Flags().StringVar(&selector, "selector", "", "CSS selector of the element to follow")
	cmd.Flags().StringVar(&rect, "rect", "", "fixed area as X,Y,WIDTH,HEIGHT in viewport CSS pixels")
	cmd.Flags().Float64Var(&zoom, "zoom", 2, "zoom factor, above 1 and at most 4")
	cmd.Flags().IntVar(&durationMs, "duration-ms", 0, "zoom out after this long (default: hold until reset-focus)")
	return cmd
}

func newRecordingsAttentionCmd(conn *connection) *cobra.Command {
	var (
		selector   string
		point      string
		radius     float64
		loops      int
		durationMs int
	)
	cmd := &cobra.Command{
		Use:   "attention SESSION_ID RECORDING_ID",
		Short: "circle the pointer around a point or an element",
		Long:  "Circles the real pointer in the recorded tab and returns when it is done. Name one of --selector and --point.",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if (selector == "") == (point == "") {
				return errors.New("name exactly one of --selector and --point")
			}
			body := map[string]any{}
			if selector != "" {
				body["selector"] = selector
			}
			if point != "" {
				numbers, err := numberList("point", point, 2)
				if err != nil {
					return err
				}
				body["point"] = map[string]float64{"x": numbers[0], "y": numbers[1]}
			}
			if radius > 0 {
				body["radius"] = radius
			}
			if loops > 0 {
				body["loops"] = loops
			}
			if durationMs > 0 {
				body["durationMs"] = durationMs
			}
			return conn.run(cmd, http.MethodPost, recordingPath(args[0], args[1], "/attention"), nil, body)
		},
	}
	cmd.Flags().StringVar(&selector, "selector", "", "CSS selector of the element to circle")
	cmd.Flags().StringVar(&point, "point", "", "point to circle as X,Y in viewport CSS pixels")
	cmd.Flags().Float64Var(&radius, "radius", 0, "circle radius in CSS pixels (default: 40)")
	cmd.Flags().IntVar(&loops, "loops", 0, "number of circles (default: 2)")
	cmd.Flags().IntVar(&durationMs, "duration-ms", 0, "how long the circling takes (default: 1200)")
	return cmd
}

// numberList parses a comma-separated list of exactly count numbers.
func numberList(kind, value string, count int) ([]float64, error) {
	parts := strings.Split(value, ",")
	if len(parts) != count {
		return nil, fmt.Errorf("%s %q: want %d comma-separated numbers", kind, value, count)
	}
	numbers := make([]float64, 0, count)
	for _, part := range parts {
		number, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
		if err != nil {
			return nil, fmt.Errorf("%s %q: want %d comma-separated numbers", kind, value, count)
		}
		numbers = append(numbers, number)
	}
	return numbers, nil
}
