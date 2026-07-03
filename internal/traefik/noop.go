package traefik

import "context"

// NoopReconciler is a test placeholder that skips Traefik rendering.
type NoopReconciler struct{}

// Reconcile is a no-op.
func (NoopReconciler) Reconcile(context.Context) error {
	return nil
}
