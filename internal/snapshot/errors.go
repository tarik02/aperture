package snapshot

import "errors"

var (
	ErrNotFound             = errors.New("snapshot not found")
	ErrNameConflict         = errors.New("snapshot name already exists")
	ErrDeleted              = errors.New("snapshot is deleted")
	ErrNotDeleted           = errors.New("snapshot is not deleted")
	ErrSessionNotFound      = errors.New("session not found")
	ErrSessionExpired       = errors.New("session expired")
	ErrSessionRunning       = errors.New("session is running")
	ErrSessionNotPromotable = errors.New("session cannot be promoted")
	ErrOverlayMissing       = errors.New("session overlay is not present")
)

// NameConflictError indicates an active snapshot already uses the name.
type NameConflictError struct {
	Name string
}

func (e *NameConflictError) Error() string {
	return "snapshot name already exists: " + e.Name
}

func (e *NameConflictError) Is(target error) bool {
	return target == ErrNameConflict
}

// DeletedError indicates the snapshot is tombstoned.
type DeletedError struct {
	Name string
}

func (e *DeletedError) Error() string {
	return "snapshot is deleted: " + e.Name
}

func (e *DeletedError) Is(target error) bool {
	return target == ErrDeleted
}

// PromotionConflictError indicates promotion cannot proceed for the session.
type PromotionConflictError struct {
	SessionID string
	Reason    string
}

func (e *PromotionConflictError) Error() string {
	if e.Reason == "" {
		return "promotion conflict for session " + e.SessionID
	}
	return "promotion conflict for session " + e.SessionID + ": " + e.Reason
}

func (e *PromotionConflictError) Is(target error) bool {
	_, ok := target.(*PromotionConflictError)
	return ok
}
