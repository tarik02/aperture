package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/aperture/aperture/internal/auth"
	"github.com/aperture/aperture/internal/db"
	"github.com/gin-gonic/gin"
)

func toUserResponse(user db.User) userResponse {
	return userResponse{
		ID:            user.ID,
		Email:         user.Email,
		DisplayName:   user.DisplayName,
		IsSystemAdmin: user.IsSystemAdmin,
		CreatedAt:     user.CreatedAt,
		UpdatedAt:     user.UpdatedAt,
		DisabledAt:    user.DisabledAt,
	}
}

func toTenantMembershipResponse(membership db.TenantMembership) (tenantMembershipResponse, error) {
	scopes, err := auth.ParseScopesJSON(membership.ScopesJSON)
	if err != nil {
		return tenantMembershipResponse{}, err
	}
	return tenantMembershipResponse{
		TenantID:  membership.TenantID,
		UserID:    membership.UserID,
		Scopes:    scopes,
		CreatedAt: membership.CreatedAt,
		UpdatedAt: membership.UpdatedAt,
	}, nil
}

func toAuditEventResponse(event db.AuditEvent) (auditEventResponse, error) {
	data := json.RawMessage("{}")
	if event.DataJSON != "" {
		if err := json.Unmarshal([]byte(event.DataJSON), &data); err != nil {
			return auditEventResponse{}, err
		}
	}
	return auditEventResponse{
		ID:           event.ID,
		ActorType:    event.ActorType,
		ActorID:      event.ActorID,
		TenantID:     event.TenantID,
		Action:       event.Action,
		ResourceType: event.ResourceType,
		ResourceID:   event.ResourceID,
		Data:         data,
		CreatedAt:    event.CreatedAt,
	}, nil
}

func (s *Server) createUser(c *gin.Context) {
	var req createUserRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}
	user, err := s.Auth.CreateUser(c.Request.Context(), auth.CreateUserInput{
		Email:         req.Email,
		DisplayName:   req.DisplayName,
		IsSystemAdmin: *req.IsSystemAdmin,
	})
	if err != nil {
		WriteError(c, err)
		return
	}
	if !s.recordAudit(c, auth.AuditInput{Action: "user.created", ResourceType: "user", ResourceID: &user.ID}) {
		return
	}
	c.JSON(http.StatusCreated, toUserResponse(*user))
}

func (s *Server) listUsers(c *gin.Context) {
	params, err := parsePageParams(c)
	if err != nil {
		WriteError(c, err)
		return
	}
	includeDisabled, disabledOnly, err := parseDisabledFilter(c)
	if err != nil {
		WriteError(c, err)
		return
	}
	page, err := s.Auth.ListUsersPage(c.Request.Context(), db.UserFilter{
		Query:           parseOptionalQuery(c, "query"),
		IncludeDisabled: includeDisabled,
		DisabledOnly:    disabledOnly,
	}, params)
	if err != nil {
		WriteError(c, mapInvalidCursor(err))
		return
	}
	users := make([]userResponse, 0, len(page.Items))
	for _, user := range page.Items {
		users = append(users, toUserResponse(user))
	}
	c.JSON(http.StatusOK, paginatedResponse[userResponse]{Data: users, Meta: page.Meta})
}

func (s *Server) getUser(c *gin.Context) {
	user, err := s.Auth.GetUser(c.Request.Context(), c.Param("userId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, toUserResponse(*user))
}

func (s *Server) updateUser(c *gin.Context) {
	var req updateUserRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}
	user, err := s.Auth.UpdateUser(c.Request.Context(), c.Param("userId"), auth.UpdateUserInput{
		Email:         req.Email,
		DisplayName:   req.DisplayName,
		IsSystemAdmin: *req.IsSystemAdmin,
	})
	if err != nil {
		WriteError(c, err)
		return
	}
	if !s.recordAudit(c, auth.AuditInput{Action: "user.updated", ResourceType: "user", ResourceID: &user.ID}) {
		return
	}
	c.JSON(http.StatusOK, toUserResponse(*user))
}

func (s *Server) disableUser(c *gin.Context) {
	user, err := s.Auth.DisableUser(c.Request.Context(), c.Param("userId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	if !s.recordAudit(c, auth.AuditInput{Action: "user.disabled", ResourceType: "user", ResourceID: &user.ID}) {
		return
	}
	c.JSON(http.StatusOK, toUserResponse(*user))
}

func (s *Server) restoreUser(c *gin.Context) {
	user, err := s.Auth.RestoreUser(c.Request.Context(), c.Param("userId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	if !s.recordAudit(c, auth.AuditInput{Action: "user.restored", ResourceType: "user", ResourceID: &user.ID}) {
		return
	}
	c.JSON(http.StatusOK, toUserResponse(*user))
}

func (s *Server) listTenantMemberships(c *gin.Context) {
	memberships, err := s.Auth.ListTenantMemberships(c.Request.Context(), c.Param("tenantId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	s.writeMemberships(c, memberships)
}

func (s *Server) listUserMemberships(c *gin.Context) {
	memberships, err := s.Auth.ListUserMemberships(c.Request.Context(), c.Param("userId"))
	if err != nil {
		WriteError(c, err)
		return
	}
	s.writeMemberships(c, memberships)
}

func (s *Server) writeMemberships(c *gin.Context, memberships []db.TenantMembership) {
	response := make([]tenantMembershipResponse, 0, len(memberships))
	for _, membership := range memberships {
		mapped, err := toTenantMembershipResponse(membership)
		if err != nil {
			WriteError(c, err)
			return
		}
		response = append(response, mapped)
	}
	c.JSON(http.StatusOK, response)
}

func (s *Server) upsertTenantMembership(c *gin.Context) {
	var req upsertTenantMembershipRequest
	if err := bindJSON(c, &req); err != nil {
		WriteError(c, err)
		return
	}
	membership, err := s.Auth.UpsertTenantMembership(c.Request.Context(), auth.UpsertMembershipInput{
		TenantID: c.Param("tenantId"),
		UserID:   c.Param("userId"),
		Scopes:   req.Scopes,
	})
	if err != nil {
		WriteError(c, err)
		return
	}
	resourceID := membership.TenantID + ":" + membership.UserID
	if !s.recordAudit(c, auth.AuditInput{
		TenantID:     &membership.TenantID,
		Action:       "tenant_membership.upserted",
		ResourceType: "tenant_membership",
		ResourceID:   &resourceID,
		Data:         map[string]any{"scopes": req.Scopes},
	}) {
		return
	}
	response, err := toTenantMembershipResponse(*membership)
	if err != nil {
		WriteError(c, err)
		return
	}
	c.JSON(http.StatusOK, response)
}

func (s *Server) deleteTenantMembership(c *gin.Context) {
	tenantID := c.Param("tenantId")
	userID := c.Param("userId")
	if err := s.Auth.DeleteTenantMembership(c.Request.Context(), tenantID, userID); err != nil {
		WriteError(c, err)
		return
	}
	resourceID := tenantID + ":" + userID
	if !s.recordAudit(c, auth.AuditInput{
		TenantID:     &tenantID,
		Action:       "tenant_membership.deleted",
		ResourceType: "tenant_membership",
		ResourceID:   &resourceID,
	}) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) listAuditEvents(c *gin.Context) {
	params, err := parsePageParams(c)
	if err != nil {
		WriteError(c, err)
		return
	}
	page, err := s.Auth.ListAuditEventsPage(c.Request.Context(), db.AuditEventFilter{
		TenantID:     parseOptionalQuery(c, "tenantId"),
		ActorType:    parseOptionalQuery(c, "actorType"),
		ActorID:      parseOptionalQuery(c, "actorId"),
		Action:       parseOptionalQuery(c, "action"),
		ResourceType: parseOptionalQuery(c, "resourceType"),
		ResourceID:   parseOptionalQuery(c, "resourceId"),
	}, params)
	if err != nil {
		WriteError(c, mapInvalidCursor(err))
		return
	}
	events := make([]auditEventResponse, 0, len(page.Items))
	for _, event := range page.Items {
		mapped, err := toAuditEventResponse(event)
		if err != nil {
			WriteError(c, err)
			return
		}
		events = append(events, mapped)
	}
	c.JSON(http.StatusOK, paginatedResponse[auditEventResponse]{Data: events, Meta: page.Meta})
}

func (s *Server) recordAudit(c *gin.Context, input auth.AuditInput) bool {
	principal := c.MustGet("principal").(auth.Principal)
	if err := s.Auth.RecordAudit(c.Request.Context(), principal, input); err != nil {
		WriteError(c, err)
		return false
	}
	return true
}

func parseDisabledFilter(c *gin.Context) (includeDisabled bool, disabledOnly bool, err error) {
	switch strings.TrimSpace(c.Query("disabled")) {
	case "", "active":
		return false, false, nil
	case "disabled":
		return true, true, nil
	case "all":
		return true, false, nil
	default:
		return false, false, validationError("disabled is invalid")
	}
}
