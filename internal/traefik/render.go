package traefik

import (
	"bytes"
	"fmt"
	"net"
	"sort"
	"strings"

	"github.com/aperture/aperture/internal/config"
	"github.com/aperture/aperture/internal/db"
	"gopkg.in/yaml.v3"
)

const (
	apiRouterPriority = 1
	cdpRouterPriority = 100
)

// RunningSession describes a session that should receive a CDP Traefik route.
type RunningSession struct {
	ID      string
	CDPPort int
}

// RenderDynamicConfig renders Traefik file-provider dynamic configuration.
func RenderDynamicConfig(cfg config.Config, running []RunningSession) ([]byte, error) {
	apertureURL, err := apertureBaseURL(cfg.ListenAddress)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrRender, err)
	}

	doc := dynamicConfig{
		HTTP: httpDynamicConfig{
			Routers:     map[string]routerConfig{},
			Middlewares: map[string]middlewareConfig{},
			Services:    map[string]serviceConfig{},
		},
	}

	doc.HTTP.Routers["aperture-api"] = routerConfig{
		Rule:        apertureCatchAllRule(cfg.CdpRouteBasePath),
		Service:     "aperture-api",
		Priority:    apiRouterPriority,
		EntryPoints: []string{"web"},
	}
	doc.HTTP.Services["aperture-api"] = serviceConfig{
		LoadBalancer: loadBalancerConfig{
			Servers: []serverConfig{{URL: apertureURL}},
		},
	}

	cdpBase := normalizedCDPRouteBase(cfg.CdpRouteBasePath)
	for _, session := range running {
		if session.ID == "" || session.CDPPort <= 0 {
			continue
		}

		routerName := cdpRouterName(session.ID)
		middlewareName := cdpMiddlewareName(session.ID)
		serviceName := cdpServiceName(session.ID)
		routePrefix := fmt.Sprintf("%s/%s", cdpBase, session.ID)
		forwardAuthURL := fmt.Sprintf(
			"%s/internal/forward-auth/cdp/%s",
			strings.TrimRight(apertureURL, "/"),
			session.ID,
		)

		doc.HTTP.Routers[routerName] = routerConfig{
			Rule:        cdpRouterRule(routePrefix),
			Service:     serviceName,
			Middlewares: []string{middlewareName, cdpStripMiddlewareName(session.ID)},
			Priority:    cdpRouterPriority,
			EntryPoints: []string{"web"},
		}
		doc.HTTP.Middlewares[middlewareName] = middlewareConfig{
			ForwardAuth: &forwardAuthConfig{
				Address: forwardAuthURL,
			},
		}
		doc.HTTP.Middlewares[cdpStripMiddlewareName(session.ID)] = middlewareConfig{
			StripPrefix: &stripPrefixConfig{
				Prefixes: []string{routePrefix},
			},
		}
		doc.HTTP.Services[serviceName] = serviceConfig{
			LoadBalancer: loadBalancerConfig{
				Servers: []serverConfig{{URL: fmt.Sprintf("http://127.0.0.1:%d", session.CDPPort)}},
			},
		}
	}

	return marshalDynamicYAML(doc)
}

// RenderStaticConfig renders Traefik static configuration from install parameters.
func RenderStaticConfig(entrypointAddress, dynamicConfigPath string) ([]byte, error) {
	entrypointAddress = strings.TrimSpace(entrypointAddress)
	dynamicConfigPath = strings.TrimSpace(dynamicConfigPath)
	if entrypointAddress == "" {
		return nil, fmt.Errorf("%w: entrypoint address is required", ErrRender)
	}
	if dynamicConfigPath == "" {
		return nil, fmt.Errorf("%w: dynamic config path is required", ErrRender)
	}

	doc := staticConfig{
		EntryPoints: map[string]entryPointConfig{
			"web": {Address: entrypointAddress},
		},
		Providers: providersConfig{
			File: fileProviderConfig{
				Filename: dynamicConfigPath,
				Watch:    true,
			},
		},
		API: apiConfig{
			Dashboard: false,
			Insecure:  false,
		},
	}

	out, err := yaml.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrRender, err)
	}
	return out, nil
}

func apertureCatchAllRule(cdpRouteBasePath string) string {
	cdpBase := normalizedCDPRouteBase(cdpRouteBasePath)
	return fmt.Sprintf(
		"PathPrefix(`/`) && !PathPrefix(`/internal`) && !PathPrefix(`%s`)",
		escapeTraefikPath(cdpBase),
	)
}

func normalizedCDPRouteBase(cdpRouteBasePath string) string {
	base := strings.TrimRight(strings.TrimSpace(cdpRouteBasePath), "/")
	if base == "" {
		return "/cdp"
	}
	return base
}

func cdpRouterRule(routePrefix string) string {
	escaped := escapeTraefikPath(routePrefix)
	return fmt.Sprintf("Path(`%s`) || PathPrefix(`%s/`)", escaped, escaped)
}

func apertureBaseURL(listenAddress string) (string, error) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(listenAddress))
	if err != nil {
		return "", fmt.Errorf("parse listen address: %w", err)
	}
	if host == "" {
		host = "127.0.0.1"
	}
	return fmt.Sprintf("http://%s:%s", host, port), nil
}

func cdpRouterName(sessionID string) string {
	return "aperture-cdp-" + sanitizeName(sessionID)
}

func cdpServiceName(sessionID string) string {
	return "aperture-cdp-service-" + sanitizeName(sessionID)
}

func cdpMiddlewareName(sessionID string) string {
	return "aperture-cdp-forward-auth-" + sanitizeName(sessionID)
}

func cdpStripMiddlewareName(sessionID string) string {
	return "aperture-cdp-strip-" + sanitizeName(sessionID)
}

func sanitizeName(value string) string {
	return strings.NewReplacer("-", "", ":", "").Replace(value)
}

func escapeTraefikPath(path string) string {
	return strings.ReplaceAll(path, "`", "")
}

type dynamicConfig struct {
	HTTP httpDynamicConfig `yaml:"http"`
}

type httpDynamicConfig struct {
	Routers     map[string]routerConfig     `yaml:"routers"`
	Middlewares map[string]middlewareConfig `yaml:"middlewares"`
	Services    map[string]serviceConfig    `yaml:"services"`
}

type routerConfig struct {
	Rule        string   `yaml:"rule"`
	Service     string   `yaml:"service"`
	Middlewares []string `yaml:"middlewares,omitempty"`
	Priority    int      `yaml:"priority"`
	EntryPoints []string `yaml:"entryPoints"`
}

type middlewareConfig struct {
	ForwardAuth *forwardAuthConfig `yaml:"forwardAuth,omitempty"`
	StripPrefix *stripPrefixConfig `yaml:"stripPrefix,omitempty"`
}

type forwardAuthConfig struct {
	Address string `yaml:"address"`
}

type stripPrefixConfig struct {
	Prefixes []string `yaml:"prefixes"`
}

type serviceConfig struct {
	LoadBalancer loadBalancerConfig `yaml:"loadBalancer"`
}

type loadBalancerConfig struct {
	Servers []serverConfig `yaml:"servers"`
}

type serverConfig struct {
	URL string `yaml:"url"`
}

type staticConfig struct {
	EntryPoints map[string]entryPointConfig `yaml:"entryPoints"`
	Providers   providersConfig             `yaml:"providers"`
	API         apiConfig                   `yaml:"api"`
}

type entryPointConfig struct {
	Address string `yaml:"address"`
}

type providersConfig struct {
	File fileProviderConfig `yaml:"file"`
}

type fileProviderConfig struct {
	Filename string `yaml:"filename"`
	Watch    bool   `yaml:"watch"`
}

type apiConfig struct {
	Dashboard bool `yaml:"dashboard"`
	Insecure  bool `yaml:"insecure"`
}

func marshalDynamicYAML(doc dynamicConfig) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeDynamicYAML(&buf, doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeDynamicYAML(buf *bytes.Buffer, doc dynamicConfig) error {
	buf.WriteString("http:\n")
	buf.WriteString("  routers:\n")

	routerNames := sortedKeys(doc.HTTP.Routers)
	for _, name := range routerNames {
		router := doc.HTTP.Routers[name]
		buf.WriteString("    " + name + ":\n")
		writeYAMLString(buf, 6, "rule", router.Rule)
		buf.WriteString("      service: " + router.Service + "\n")
		if len(router.Middlewares) > 0 {
			buf.WriteString("      middlewares:\n")
			for _, middleware := range router.Middlewares {
				buf.WriteString("        - " + middleware + "\n")
			}
		}
		buf.WriteString(fmt.Sprintf("      priority: %d\n", router.Priority))
		buf.WriteString("      entryPoints:\n")
		for _, entrypoint := range router.EntryPoints {
			buf.WriteString("        - " + entrypoint + "\n")
		}
	}

	buf.WriteString("  middlewares:\n")
	middlewareNames := sortedKeys(doc.HTTP.Middlewares)
	for _, name := range middlewareNames {
		middleware := doc.HTTP.Middlewares[name]
		buf.WriteString("    " + name + ":\n")
		switch {
		case middleware.ForwardAuth != nil:
			buf.WriteString("      forwardAuth:\n")
			writeYAMLString(buf, 8, "address", middleware.ForwardAuth.Address)
		case middleware.StripPrefix != nil:
			buf.WriteString("      stripPrefix:\n")
			buf.WriteString("        prefixes:\n")
			for _, prefix := range middleware.StripPrefix.Prefixes {
				buf.WriteString("          - ")
				writeYAMLScalar(buf, prefix)
				buf.WriteString("\n")
			}
		}
	}

	buf.WriteString("  services:\n")
	serviceNames := sortedKeys(doc.HTTP.Services)
	for _, name := range serviceNames {
		service := doc.HTTP.Services[name]
		buf.WriteString("    " + name + ":\n")
		buf.WriteString("      loadBalancer:\n")
		buf.WriteString("        servers:\n")
		for _, server := range service.LoadBalancer.Servers {
			buf.WriteString("          - url: ")
			writeYAMLScalar(buf, server.URL)
			buf.WriteString("\n")
		}
	}

	return nil
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func writeYAMLString(buf *bytes.Buffer, indent int, key, value string) {
	padding := strings.Repeat(" ", indent)
	if strings.ContainsAny(value, ":`\"'") {
		buf.WriteString(padding + key + ": \"" + strings.ReplaceAll(value, "\"", "\\\"") + "\"\n")
		return
	}
	buf.WriteString(padding + key + ": " + value + "\n")
}

func writeYAMLScalar(buf *bytes.Buffer, value string) {
	if strings.ContainsAny(value, ":`\"'#") || strings.HasPrefix(value, " ") {
		buf.WriteString("\"" + strings.ReplaceAll(value, "\"", "\\\"") + "\"")
		return
	}
	buf.WriteString(value)
}

// RunningSessionsFromDB converts running session rows into render input.
func RunningSessionsFromDB(sessions []db.Session) []RunningSession {
	running := make([]RunningSession, 0, len(sessions))
	for _, session := range sessions {
		if session.CurrentCDPPort == nil || *session.CurrentCDPPort <= 0 {
			continue
		}
		running = append(running, RunningSession{
			ID:      session.ID,
			CDPPort: *session.CurrentCDPPort,
		})
	}
	sort.Slice(running, func(i, j int) bool {
		return running[i].ID < running[j].ID
	})
	return running
}
