package browser

import "encoding/json"

func (p *cdpProxy) beginAction(active bool) {
	p.actionMu.Lock()
	p.actionTarget = ""
	p.retries = nil
	p.action.Store(active)
	p.actionMu.Unlock()
}

// A mutating MCP tool evaluates its action's page before collecting every tab's
// title for the response. Keep that action target through the background reads.
// Utility-world evaluations also mutate forms, so execution worlds cannot
// distinguish actions from title probes.
func (c *cdpProxyConn) prepareEvaluation(raw []byte) bool {
	if !c.proxy.action.Load() {
		return true
	}
	var message cdpMessage
	if json.Unmarshal(raw, &message) != nil {
		return true
	}
	_, root, known := c.rootSession(message.SessionID)
	if !known || root.kind != "page" {
		return true
	}
	p := c.proxy
	p.actionMu.Lock()
	if p.actionTarget == "" {
		p.actionTarget = root.targetID
	}
	selected := p.actionTarget == root.targetID
	p.actionMu.Unlock()
	if !selected {
		return true
	}
	return c.prepareTarget(raw)
}
