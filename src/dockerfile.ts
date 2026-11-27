/**
 * Generates a game server Dockerfile for a specific project.
 *
 * The validator in serverconfig.ts tells an agent what is wrong with a
 * Dockerfile; this writes one that is right to begin with, for the project's
 * actual build folder, binary name, ports and launch arguments, so the agent
 * does not have to adapt a fixed template by trial and error.
 *
 * Unity output follows the Dockerfile the Edgegap Unity plugin writes (Unity
 * projects normally build and push with that plugin; this is for projects that
 * don't). Unreal output follows the edgegap-unreal skill and the Edgegap
 * Unreal SDK's build panel: the server binary runs directly, not through the
 * generated <Module>Server.sh, which does not exec and so swallows the SIGTERM
 * Edgegap sends on stop. Godot and "other" follow the same conventions. Every template must
 * pass validateServerConfig; newtools.mjs enforces that.
 */

import { Engine, PortInput, protocolForNetcode } from './serverconfig.js';

export interface DockerfileInput {
  engine: Engine;
  build_path?: string;
  executable?: string;
  ports?: PortInput[];
  netcode?: string;
  launch_args?: string[];
  base_image?: string;
}

// Every value below is interpolated into Dockerfile lines, and launch_args into
// a shell command for Unity, so each is restricted to characters that cannot
// start a new instruction, quote out of an argument, or run a subshell.
const PATH_RE = /^[A-Za-z0-9._\-/]+$/;
const ARG_RE = /^[A-Za-z0-9._\-=:/,+@]+$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]*$/;

const DEFAULTS: Record<Engine, { build_path: string; executable?: string }> = {
  unity: { build_path: 'Builds/EdgegapServer', executable: 'ServerBuild' },
  unreal: { build_path: 'Packaged/LinuxServer', executable: 'MyGame/Binaries/Linux/MyGameServer' },
  godot: { build_path: 'build', executable: 'server.x86_64' },
  other: { build_path: 'build' },
};

export class DockerfileInputError extends Error {}

function exposeLines(ports: PortInput[]): string[] {
  const lines: string[] = [];
  for (const p of ports) {
    const proto = p.protocol.toUpperCase();
    if (proto === 'TCP/UDP') lines.push(`EXPOSE ${p.port}/udp`, `EXPOSE ${p.port}/tcp`);
    else lines.push(`EXPOSE ${p.port}/${proto === 'UDP' ? 'udp' : 'tcp'}`);
  }
  return lines;
}

/** Linux packages every template installs: CA certificates, so the server can
 *  call HTTPS APIs (Edgegap's context API, backends, analytics). */
const APT = [
  'RUN apt-get update && \\',
  '    apt-get install -y --no-install-recommends ca-certificates && \\',
  '    apt-get clean && rm -rf /var/lib/apt/lists/*',
];

/**
 * Unprivileged user. Required for Unreal, good practice everywhere else. No
 * fixed uid: official node images already use 1000 ("node"), and
 * "useradd -u 1000" fails the build there. Skipped when "server" exists.
 */
const USER_SETUP = 'RUN id -u server >/dev/null 2>&1 || useradd -m server';

/**
 * Unreal server arguments. A packaged binary at <Project>/Binaries/Linux/<X>
 * takes the project name first (what <Module>Server.sh passes), then the flags
 * the skill and the SDK panel use, unless launch_args already sets them.
 */
function unrealArgs(executable: string, isScript: boolean, port: number | undefined, args: string[]): string[] {
  if (isScript) return args;
  const has = (flag: string) => args.some((a) => a.toLowerCase() === flag.toLowerCase() || a.toLowerCase().startsWith(`${flag.toLowerCase()}=`));
  const project = /^([^/]+)\/Binaries\/Linux\/[^/]+$/.exec(executable)?.[1];
  const out: string[] = [];
  if (project && args[0] !== project) out.push(project);
  if (!has('-log')) out.push('-log');
  if (port !== undefined && !has('-port')) out.push(`-port=${port}`);
  if (!has('-stdout')) out.push('-stdout');
  if (!has('-FullStdOutLogOutput')) out.push('-FullStdOutLogOutput');
  return [...out, ...args];
}

export function generateDockerfile(input: DockerfileInput) {
  const engine = input.engine;
  const defaults = DEFAULTS[engine];
  const assumptions: string[] = [];

  const buildPath = input.build_path ?? defaults.build_path;
  const executable = input.executable ?? defaults.executable;
  const base = input.base_image ?? 'ubuntu:22.04';
  const args = input.launch_args ?? [];

  if (!executable) {
    throw new DockerfileInputError(
      'executable is required for engine "other": the file name of the server binary or start script inside build_path.'
    );
  }
  if (!PATH_RE.test(buildPath) || buildPath.split('/').includes('..') || buildPath.startsWith('/')) {
    throw new DockerfileInputError(
      `build_path "${buildPath}" must be a relative path inside the Docker build context (letters, digits, ".", "_", "-", "/"; no "..").`
    );
  }
  if (!PATH_RE.test(executable) || executable.split('/').includes('..') || executable.startsWith('/')) {
    throw new DockerfileInputError(
      `executable "${executable}" must be a file name or a relative path inside build_path (letters, digits, ".", "_", "-", "/"; no "..").`
    );
  }
  for (const a of args) {
    if (!ARG_RE.test(a)) {
      throw new DockerfileInputError(
        `launch argument "${a}" contains characters that are not allowed (spaces, quotes, $, ;, |, &, backticks). Pass each argument separately.`
      );
    }
  }
  if (!IMAGE_RE.test(base)) {
    throw new DockerfileInputError(`base_image "${base}" is not a valid image reference.`);
  }

  // ------------------------------------------------------------- ports ----
  // A WebSocket transport means browser (WebGL) clients, which need wss://:
  // Edgegap's TLS Upgrade on the WS port.
  const browserNetcode = input.netcode !== undefined && protocolForNetcode(input.netcode) === 'WS';
  let autoTls = false; // set when TLS was turned on without being asked for
  let ports: Array<{ port: number; protocol: string; name: string; tls_upgrade?: boolean }>;
  if (input.ports && input.ports.length > 0) {
    ports = input.ports.map((p, i) => {
      const protocol = p.protocol.toUpperCase();
      let tls = p.tls_upgrade;
      if (tls === undefined && browserNetcode && protocol === 'WS') {
        tls = true;
        autoTls = true;
      }
      return {
        port: p.port,
        protocol,
        name: p.name ?? (i === 0 ? 'gameport' : `port${i + 1}`),
        ...(tls !== undefined ? { tls_upgrade: tls } : {}),
      };
    });
  } else {
    const protocol = (input.netcode && protocolForNetcode(input.netcode)) || 'UDP';
    ports = [{ port: 7777, protocol, name: 'gameport', ...(browserNetcode ? { tls_upgrade: true } : {}) }];
    autoTls = browserNetcode;
    assumptions.push(
      `Assumed the server listens on 7777/${protocol}${input.netcode ? ` (the protocol ${input.netcode} uses)` : ''}. ` +
        'Confirm the port in the server\'s network/transport settings and pass ports if it differs.'
    );
  }

  // --------------------------------------------------------- templates ----
  const expose = exposeLines(ports);
  let lines: string[];

  if (engine === 'unity') {
    // Shell form so $UNITY_COMMANDLINE_ARGS (settable per deployment) expands.
    // Edgegap's plugin template also prints `env` first; that is left out on
    // purpose, since it writes every environment variable, hidden ones
    // included, into the container logs.
    const command = [`/root/build/${executable}`, '-batchmode', '-nographics', ...args, '$UNITY_COMMANDLINE_ARGS'].join(' ');
    lines = [
      `FROM ${base}`,
      '',
      'ARG DEBIAN_FRONTEND=noninteractive',
      ...APT,
      '',
      `# Linux Dedicated Server build folder (${executable}, *_Data, UnityPlayer.so).`,
      `COPY ${buildPath} /root/build/`,
      'WORKDIR /root/',
      `RUN chmod +x /root/build/${executable}`,
      '',
      '# Documentation only: the port Edgegap exposes is the one on the app version.',
      ...expose,
      '',
      `CMD ["/bin/bash", "-c", "${command}"]`,
    ];
    if (input.executable === undefined) {
      assumptions.push(
        'Assumed the server binary is named "ServerBuild". Unity names it after the build file you chose; check the build folder and pass executable if it differs.'
      );
    }
  } else if (engine === 'unreal') {
    const isScript = executable.endsWith('.sh');
    lines = [
      `FROM ${base}`,
      '',
      'ARG DEBIAN_FRONTEND=noninteractive',
      ...APT,
      '',
      '# Unreal refuses to start as root.',
      USER_SETUP,
      'WORKDIR /app',
      `COPY --chown=server:server ${buildPath} /app/`,
      isScript
        ? `# Scripts saved on Windows carry CRLF endings, which break the shebang.\nRUN sed -i 's/\\r$//' /app/${executable} && chmod +x /app/${executable}`
        : `RUN chmod +x /app/${executable}`,
      'USER server',
      '',
      '# Documentation only: the port Edgegap exposes is the one on the app version.',
      ...expose,
      '',
      ...(isScript
        ? []
        : [
            '# -stdout -FullStdOutLogOutput: without them stdout is buffered and Edgegap logs stay empty.',
          ]),
      `CMD ${JSON.stringify([`/app/${executable}`, ...unrealArgs(executable, isScript, ports[0]?.port, args)])}`,
    ];
    if (input.executable === undefined) {
      assumptions.push(
        'Assumed the packaged server binary is MyGame/Binaries/Linux/MyGameServer inside Packaged/LinuxServer. ' +
          'Pass executable as <Project>/Binaries/Linux/<Module>Server from the packaged LinuxServer folder (and build_path if ' +
          'it was packaged elsewhere). Run the binary, not <Module>Server.sh: that script does not exec, so it swallows the ' +
          'SIGTERM Edgegap sends on stop.'
      );
    } else if (isScript) {
      assumptions.push(
        'A start script only stops cleanly on Edgegap if it ends with exec; the generated <Module>Server.sh does not. ' +
          'Prefer executable <Project>/Binaries/Linux/<Module>Server.'
      );
    }
  } else {
    // Godot and other engines: same shape as Unreal, minus the CRLF fix
    // unless the entry point is a script.
    const isScript = executable.endsWith('.sh');
    const launch = engine === 'godot' ? [`/app/${executable}`, '--headless', ...args] : [`/app/${executable}`, ...args];
    lines = [
      `FROM ${base}`,
      '',
      'ARG DEBIAN_FRONTEND=noninteractive',
      ...APT,
      '',
      USER_SETUP,
      'WORKDIR /app',
      `COPY --chown=server:server ${buildPath} /app/`,
      isScript
        ? `RUN sed -i 's/\\r$//' /app/${executable} && chmod +x /app/${executable}`
        : `RUN chmod +x /app/${executable}`,
      'USER server',
      '',
      '# Documentation only: the port Edgegap exposes is the one on the app version.',
      ...expose,
      '',
      `CMD ${JSON.stringify(launch)}`,
    ];
    if (engine === 'godot') {
      assumptions.push(
        'Export with the Linux x86_64 preset. If the .pck is exported separately, keep it next to the binary in the build folder.'
      );
      if (input.executable === undefined) {
        assumptions.push('Assumed the exported binary is named "server.x86_64"; pass executable if yours differs.');
      }
    }
  }

  if (autoTls) {
    assumptions.push(
      'Turned on tls_upgrade for the WebSocket port, because WebSocket transports usually mean ' +
        'browser (WebGL) clients, which need wss://. Set tls_upgrade: false if no client runs in a browser.'
    );
  }

  assumptions.push(
    buildPath === '.'
      ? 'Run docker build from inside the server build folder (the folder itself is the build context).'
      : `Run docker build from the folder that contains ${buildPath}.`
  );

  return {
    dockerfile: lines.join('\n') + '\n',
    ports,
    assumptions,
    build_path: buildPath,
    executable,
  };
}
