import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Actions from "./actions/layer.ts";
import { Actions as ActionsService } from "./actions/service.ts";
import * as GitHub from "./github/layer.ts";
import * as Images from "./images.ts";
import * as Programs from "./programs/layer.ts";
import * as Release from "./release.ts";
import * as SmokeBundles from "./smoke/bundles.ts";
import * as SmokeCompose from "./smoke/compose.ts";
import * as SmokeImage from "./smoke/image.ts";
import * as Version from "./version.ts";

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Tell what would be published, and publish nothing"),
);
const output = Flag.String("output").pipe(
  Flag.withDescription("The step output it is given as"),
  Flag.optional,
);
const outputs = (name: Option.Option<string>, value: string) =>
  Option.match(name, {
    onNone: () => Console.log(value),
    onSome: (name) => ActionsService.use((actions) => actions.output(name, value)),
  });
const files = Flag.String("out").pipe(
  Flag.withDescription("The directory the files are put in"),
  Flag.withDefault("files"),
);

const version = Command.make("version").pipe(
  Command.withDescription("The version the tree is built as"),
  Command.withSubcommands([
    Command.make(
      "set",
      {
        version: Argument.String("version").pipe(Argument.withSchema(Version.Version)),
      },
      ({ version }) => Version.setVersion(version),
    ).pipe(Command.withDescription("Write one version wherever the tree keeps it")),
    Command.make("nightly", { dryRun }, ({ dryRun }) => Version.nightly(!dryRun)).pipe(
      Command.withDescription(
        "Make the release of a nightly, of GITHUB_SHA and GITHUB_RUN_NUMBER; its version and the short hash are the step's outputs",
      ),
    ),
  ]),
);

const filesCommand = Command.make("files").pipe(
  Command.withDescription("The files of a release beside its images"),
  Command.withSubcommands([
    Command.make(
      "cli",
      {
        target: Flag.Literals("target", Object.keys(Release.CLI_TARGETS) as Release.CliTarget[]),
        out: files,
      },
      ({ target, out }) => Release.cli(target, out),
    ).pipe(Command.withDescription("Build the `aperture` program for a target")),
    Command.make("bundles", { out: files }, ({ out }) => Release.bundles(out)).pipe(
      Command.withDescription("Build the runner and the browser as `aperture run` downloads them"),
    ),
    Command.make("companion", {}, () => Release.companion()).pipe(
      Command.withDescription("Build and zip the Companion extension"),
    ),
    Command.make(
      "publish",
      {
        tag: Flag.String("tag").pipe(Flag.withDescription("The release's tag")),
        dir: Flag.String("dir").pipe(
          Flag.withDescription("The directory of the files"),
          Flag.withDefault("files"),
        ),
        dryRun,
      },
      ({ tag, dir, dryRun }) => Release.publish(dir, tag, !dryRun),
    ).pipe(Command.withDescription("Write SHA256SUMS of the files, and put them on the release")),
  ]),
);

// Not `--version`, which is the tool's own.
const imageVersion = Flag.String("image-version").pipe(
  Flag.withDescription("The version the images were built as"),
);
const sign = Flag.Boolean("sign").pipe(Flag.withDescription("Sign it with cosign"));

const image = Command.make("image").pipe(
  Command.withDescription("The images in the registry"),
  Command.withSubcommands([
    Command.make(
      "push",
      {
        archive: Flag.String("archive").pipe(Flag.withDescription("The image's archive")),
        name: Flag.String("name").pipe(Flag.withDescription("What the archive names the image")),
        repository: Flag.String("repository").pipe(Flag.withDescription("Where it is pushed")),
        version: imageVersion,
        arch: Flag.String("arch"),
        sign,
        output,
      },
      ({ output: name, ...pushed }) =>
        Images.push(pushed).pipe(Effect.flatMap((digest) => outputs(name, digest))),
    ).pipe(Command.withDescription("Push the image of an architecture, and give its digest")),
    Command.make(
      "manifest",
      {
        repository: Flag.String("repository"),
        version: imageVersion,
        tags: Flag.String("tags").pipe(Flag.withDescription("The manifest's tags, a line each")),
        sign,
        output,
      },
      ({ output: name, tags, ...published }) =>
        Images.manifest({ ...published, tags: Images.tagsOf(tags) }).pipe(
          Effect.flatMap((digest) => outputs(name, digest)),
        ),
    ).pipe(
      Command.withDescription(
        "Publish the manifest of both architectures' images, and give its digest",
      ),
    ),
  ]),
);

const nix = Command.make("nix").pipe(
  Command.withDescription("What the flake has"),
  Command.withSubcommands([
    Command.make(
      "out-paths",
      {
        packages: Argument.String("package").pipe(Argument.variadic({ min: 1 })),
        output: Flag.String("output").pipe(Flag.withDescription("The step output it is given as")),
      },
      ({ packages, output }) => Images.outPaths(packages, output),
    ).pipe(Command.withDescription("Give the store paths of the flake's packages, a line each")),
  ]),
);

const smoke = Command.make("smoke").pipe(
  Command.withDescription("Start what was built as its users start it, and ask it from outside"),
  Command.withSubcommands([
    Command.make(
      "bundles",
      { runner: Argument.String("runner-bundle"), browser: Argument.String("browser-bundle") },
      ({ runner, browser }) => SmokeBundles.bundles(runner, browser),
    ).pipe(Command.withDescription("A session from a release's runner and browser")),
    Command.make(
      "image",
      {
        archive: Argument.String("image-archive"),
        port: Flag.Int("port").pipe(Flag.withDefault(7900)),
      },
      ({ archive, port }) => SmokeImage.image(archive, port),
    ).pipe(Command.withDescription("The session's image, under Podman")),
    Command.make(
      "compose",
      {
        control: Argument.String("control-image-archive"),
        node: Argument.String("node-image-archive"),
        port: Flag.Int("port").pipe(Flag.withDefault(8080)),
      },
      ({ control, node, port }) => SmokeCompose.compose(control, node, port),
    ).pipe(Command.withDescription("A deployment as deploy/compose.yaml has it, under Docker")),
  ]),
);

const tools = Command.make("tools").pipe(
  Command.withDescription("What CI and a release run beside the builds"),
  Command.withSubcommands([version, filesCommand, image, nix, smoke]),
);

const services = Layer.mergeAll(Actions.layer, GitHub.layer).pipe(
  Layer.provideMerge(Programs.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
);

NodeRuntime.runMain(
  Command.run(tools, { version: "0.0.0" }).pipe(
    Effect.tapError((error) =>
      CliError.isCliError(error) ? Effect.void : Console.error(String(error)),
    ),
    Effect.provide(services),
  ),
  { disableErrorReporting: true },
);
