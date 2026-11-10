package clientcli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
	"unicode"

	"github.com/spf13/cobra"
)

const (
	formatJSON  = "json"
	formatTable = "table"

	// maxCell keeps one long title or URL from pushing the other columns off screen.
	maxCell = 60
)

// table describes how a list answer is laid out for a person.
type table struct {
	// rows is the field holding the list; empty when the answer is the list.
	rows    string
	columns []column
}

type column struct {
	header string
	field  string
}

// tabular reports whether a list is printed as a table: when asked for, or by
// default when a person is reading at a terminal. A pipe gets JSON.
func (c *connection) tabular(cmd *cobra.Command) (bool, error) {
	switch c.format {
	case formatTable:
		return true, nil
	case formatJSON:
		return false, nil
	case "":
		file, ok := cmd.OutOrStdout().(*os.File)
		if !ok {
			return false, nil
		}
		info, err := file.Stat()
		return err == nil && info.Mode()&os.ModeCharDevice != 0, nil
	}
	return false, fmt.Errorf("format %q: want %s or %s", c.format, formatJSON, formatTable)
}

// list sends one API request and prints the list it answers with.
func (c *connection) list(cmd *cobra.Command, path string, query url.Values, layout table) error {
	tabular, err := c.tabular(cmd)
	if err != nil {
		return err
	}
	answer, err := c.call(cmd.Context(), "GET", path, query, nil)
	if err != nil {
		return err
	}
	if !tabular {
		return printJSON(cmd, answer)
	}

	var decoded any
	if err := json.Unmarshal(answer, &decoded); err != nil {
		return printJSON(cmd, answer)
	}
	rows := decoded
	envelope, _ := decoded.(map[string]any)
	if layout.rows != "" {
		rows = envelope[layout.rows]
	}
	items, ok := rows.([]any)
	if !ok {
		return printJSON(cmd, answer)
	}

	writer := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
	headers := make([]string, 0, len(layout.columns))
	for _, column := range layout.columns {
		headers = append(headers, column.header)
	}
	_, _ = fmt.Fprintln(writer, strings.Join(headers, "\t"))
	for _, item := range items {
		object, _ := item.(map[string]any)
		cells := make([]string, 0, len(layout.columns))
		for _, column := range layout.columns {
			cells = append(cells, cell(object[column.field]))
		}
		_, _ = fmt.Fprintln(writer, strings.Join(cells, "\t"))
	}
	if err := writer.Flush(); err != nil {
		return err
	}

	if meta, ok := envelope["meta"].(map[string]any); ok && meta["hasMore"] == true {
		cmd.PrintErrf("more: --cursor %s\n", cell(meta["nextCursor"]))
	}
	return nil
}

// cell renders one value for a table. Text comes from the instance, so control
// characters are dropped before it reaches the terminal.
func cell(value any) string {
	var text string
	switch typed := value.(type) {
	case nil:
		return "-"
	case string:
		if moment, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			return moment.Local().Format("2006-01-02 15:04")
		}
		text = typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(typed)
	default:
		encoded, _ := json.Marshal(typed)
		text = string(encoded)
	}

	text = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, text)
	if text == "" {
		return "-"
	}
	if runes := []rune(text); len(runes) > maxCell {
		return string(runes[:maxCell-1]) + "…"
	}
	return text
}
