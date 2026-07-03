package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type gcJobResponse struct {
	ExpiredSessions    int `json:"expiredSessions"`
	RemovedArtifacts   int `json:"removedArtifacts"`
	CollectedSnapshots int `json:"collectedSnapshots"`
}

func (s *Server) runGCJob(c *gin.Context) {
	if s.GC == nil {
		c.JSON(http.StatusInternalServerError, errorBody{Error: "gc service unavailable"})
		return
	}

	result, err := s.GC.Run(c.Request.Context())
	if err != nil {
		WriteError(c, err)
		return
	}

	c.JSON(http.StatusOK, gcJobResponse{
		ExpiredSessions:    result.ExpiredSessions,
		RemovedArtifacts:   result.RemovedArtifacts,
		CollectedSnapshots: result.CollectedSnapshots,
	})
}
