package traefik

import "context"

// Reconciler regenerates Traefik dynamic configuration from current state.
type Reconciler interface {
	Reconcile(ctx context.Context) error
}

// NoopReconciler is a Stage 4 placeholder until Traefik rendering lands in Stage 5.
type NoopReconciler struct{}

// Reconcile is a no-op for Stage 4.
func (NoopReconciler) Reconcile(context.Context) error {
	return nil
}
