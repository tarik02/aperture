package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/aperture/aperture/internal/control"
	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
)

func (s *Server) controlSession(c *gin.Context) {
	if s.Sessions == nil {
		WriteError(c, errSessionServiceUnavailable)
		return
	}

	port, err := s.Sessions.RunningCDPPort(
		c.Request.Context(),
		tenantIDFromContext(c),
		c.Param("sessionId"),
	)
	if err != nil {
		WriteError(c, err)
		return
	}

	conn, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		if !c.Writer.Written() {
			WriteError(c, err)
		}
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "control session closed")

	if err := control.Run(c.Request.Context(), c.Param("sessionId"), port, conn); err != nil && !isControlDisconnect(err) {
		_ = writeControlCloseError(c.Request.Context(), conn, err)
	}
}

func isControlDisconnect(err error) bool {
	if err == nil {
		return true
	}
	return websocket.CloseStatus(err) == websocket.StatusNormalClosure ||
		errors.Is(err, http.ErrServerClosed)
}

func writeControlCloseError(ctx context.Context, conn *websocket.Conn, err error) error {
	payload := []byte(`{"type":"error","code":"browser_control_failed","message":"browser control failed"}`)
	writeErr := conn.Write(ctx, websocket.MessageText, payload)
	closeErr := conn.Close(websocket.StatusInternalError, "control gateway failed")
	return errors.Join(err, writeErr, closeErr)
}
