package config

import (
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/viper"
)

const (
	envPrefix     = "APERTURE"
	defaultConfig = "aperture"
)

// Config holds resolved runtime configuration decoded from Viper.
type Config struct {
	ListenAddress string `mapstructure:"listen_address"`
	LogLevel      string `mapstructure:"log_level"`
	ConfigFile    string `mapstructure:"-"`
}

// Defaults returns built-in default configuration values.
func Defaults() Config {
	return Config{
		ListenAddress: "127.0.0.1:8080",
		LogLevel:      "info",
	}
}

// Load resolves configuration using flag, environment, file, and default precedence.
func Load(flags *viper.Viper) (Config, error) {
	v := viper.New()
	v.SetEnvPrefix(envPrefix)
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_", "-", "_"))
	v.AutomaticEnv()

	defaults := Defaults()
	v.SetDefault("listen_address", defaults.ListenAddress)
	v.SetDefault("log_level", defaults.LogLevel)

	if configFile := flags.GetString("config"); configFile != "" {
		v.SetConfigFile(configFile)
	} else {
		v.SetConfigName(defaultConfig)
		v.AddConfigPath(".")
		v.AddConfigPath("$HOME/.config/aperture")
	}

	explicitConfig := flags.GetString("config") != ""
	if err := v.ReadInConfig(); err != nil {
		if explicitConfig {
			return Config{}, fmt.Errorf("read config %s: %w", flags.GetString("config"), err)
		}

		var notFound viper.ConfigFileNotFoundError
		if !errors.As(err, &notFound) {
			return Config{}, fmt.Errorf("read config: %w", err)
		}
	}

	if flags.IsSet("listen-address") {
		v.Set("listen_address", flags.GetString("listen-address"))
	}
	if flags.IsSet("log-level") {
		v.Set("log_level", flags.GetString("log-level"))
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return Config{}, err
	}

	if v.ConfigFileUsed() != "" {
		cfg.ConfigFile = v.ConfigFileUsed()
	}

	return cfg, Validate(cfg)
}
