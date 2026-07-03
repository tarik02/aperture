package overlay

import "github.com/aperture/aperture/internal/sudo"

// MountRequestFromIDs builds a mount request from trusted ids.
func MountRequestFromIDs(sessionID string, baseSnapshotID *string) sudo.MountRequest {
	if baseSnapshotID == nil || *baseSnapshotID == "" {
		return sudo.MountRequest{SessionID: sessionID, Empty: true}
	}
	return sudo.MountRequest{
		SessionID:      sessionID,
		BaseSnapshotID: *baseSnapshotID,
	}
}
