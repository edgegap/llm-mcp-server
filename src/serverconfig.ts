/**
 * Static checks for a game server Dockerfile and its Edgegap port config.
 *
 * This is the step an agent gets wrong most often and learns about latest:
 * a Dockerfile that builds and runs locally, then fails on Edgegap because the
 * image is arm64, the server runs as root under Unreal, the port the server
 * listens on is not the port the version exposes, or the protocol is TCP where
 * the transport speaks UDP. Every one of those costs a build, a push, a version
 * and a deployment to discover. Checking the text first costs nothing.
 *
 * No network, no Docker daemon. The rules come from the Dockerfiles Edgegap
 * ships in its Unity and Unreal plugins, and from the constraints the API
 * enforces on app versions.
 */

import { badImage, badTag } from './image.js';

export type Engine = 'unity' | 'unreal' | 'godot' | 'other';

export const PROTOCOLS = ['UDP', 'TCP', 'TCP/UDP', 'HTTP', 'HTTPS', 'WS', 'WSS'] as const;

/** Transport → protocol it needs on the wire. Keys are lowercase. */
const NETCODE_PROTOCOL: Record<string, string> = {
  'mirror-kcp': 'UDP',
  kcp: 'UDP',
  'mirror-telepathy': 'TCP',
  telepathy: 'TCP',
  'mirror-simpleweb': 'WS',
  simpleweb: 'WS',
  websocket: 'WS',
  'fishnet-tugboat': 'UDP',
  tugboat: 'UDP',
  'netcode-for-gameobjects': 'UDP',
  ngo: 'UDP',
  'unity-transport': 'UDP',
  utp: 'UDP',
  'photon-fusion': 'UDP',
  litenetlib: 'UDP',
  enet: 'UDP',
  'unreal-netdriver': 'UDP',
  'godot-enet': 'UDP',
  'godot-websocket': 'WS',
};

export const NETCODE_NAMES = Object.keys(NETCODE_PROTOCOL);

export interface PortInput {
  port: number;
  protocol: string;
  name?: string;
  /** Edgegap terminates TLS on the port (wss/https). WS and HTTP only. */
  tls_upgrade?: boolean;
}

export interface ServerConfigInput {
  dockerfile?: string;
  engine?: Engine;
  netcode?: string;
  ports?: PortInput[];
  cpu_units?: number;
  memory_mb?: number;
  docker_repository?: string;
  docker_image?: string;
  docker_tag?: string;
}

export interface Finding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  fix: string;
  line?: number;
}

/** Protocol a netcode transport needs on the wire, or undefined if unknown. */
export function protocolForNetcode(netcode: string): string | undefined {
  return NETCODE_PROTOCOL[netcode.toLowerCase()];
}

interface Instruction {
  line: number;
  op: string;
  args: string;
}

/** Joins backslash continuations and drops comments, keeping the start line. */
function parseDockerfile(text: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let buf = '';
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!buf && (trimmed === '' || trimmed.startsWith('#'))) continue;
    if (!buf) start = i + 1;
    if (trimmed.endsWith('\\')) {
      buf += trimmed.slice(0, -1) + ' ';
      continue;
    }
    buf += trimmed;
    const m = buf.match(/^(\w+)\s*(.*)$/s);
    if (m) out.push({ line: start, op: m[1].toUpperCase(), args: m[2].trim() });
    buf = '';
  }
  return out;
}

function detectEngine(text: string): Engine {
  if (/-batchmode|-nographics|UNITY_|UnityPlayer|\.x86_64\b/i.test(text)) return 'unity';
  if (/StartServer\.sh|UnrealServer|Binaries\/Linux|LinuxServer|Server\.sh\b/i.test(text)) return 'unreal';
  if (/godot|--headless|\.pck\b/i.test(text)) return 'godot';
  return 'other';
}

function parseExpose(args: string): Array<{ port: number; protocol: string }> {
  return args
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const [p, proto] = tok.split('/');
      return { port: Number.parseInt(p, 10), protocol: (proto ?? 'tcp').toUpperCase() };
    })
    .filter((e) => Number.isFinite(e.port));
}

/** Does an Edgegap port protocol carry this EXPOSE protocol (tcp|udp)? */
function carries(edgegapProtocol: string, exposeProtocol: string): boolean {
  const p = edgegapProtocol.toUpperCase();
  if (p === 'TCP/UDP') return true;
  if (exposeProtocol === 'UDP') return p === 'UDP';
  return p !== 'UDP'; // TCP, HTTP, HTTPS, WS, WSS all ride on TCP
}

export function validateServerConfig(input: ServerConfigInput) {
  const findings: Finding[] = [];
  const err = (code: string, message: string, fix: string, line?: number) =>
    findings.push({ severity: 'error', code, message, fix, line });
  const warn = (code: string, message: string, fix: string, line?: number) =>
    findings.push({ severity: 'warning', code, message, fix, line });

  let engine: Engine = input.engine ?? 'other';
  const exposed: Array<{ port: number; protocol: string; line: number }> = [];

  // ------------------------------------------------------------ Dockerfile --
  if (input.dockerfile !== undefined) {
    const text = input.dockerfile;
    const ins = parseDockerfile(text);
    if (!input.engine) engine = detectEngine(text);

    const froms = ins.filter((i) => i.op === 'FROM');
    const finalFrom = froms[froms.length - 1];
    if (!finalFrom) {
      err('no-from', 'The Dockerfile has no FROM instruction.', 'Start from a Linux base image, e.g. "FROM ubuntu:22.04".');
    } else {
      const platform = finalFrom.args.match(/--platform=(\S+)/)?.[1];
      const image = finalFrom.args.replace(/--\S+/g, '').trim().split(/\s+/)[0] ?? '';
      if (platform && platform.toLowerCase() !== 'linux/amd64' && !platform.includes('$')) {
        err('wrong-platform', `Final stage is pinned to ${platform}. Edgegap runs linux/amd64 only.`,
          'Use "FROM --platform=linux/amd64 ..." or drop the flag and build with "docker build --platform linux/amd64".', finalFrom.line);
      }
      if (/(^|\/)(arm64v8|arm32v7|arm32v6)\//i.test(image) || /[-:]arm64\b/i.test(image)) {
        err('arm-base-image', `Base image "${image}" is an ARM image. Edgegap runs linux/amd64 only.`,
          'Use the multi-arch or amd64 variant of the image.', finalFrom.line);
      }
      if (/windows|nanoserver|servercore/i.test(image)) {
        err('windows-base-image', `Base image "${image}" is a Windows container. Edgegap runs Linux containers.`,
          'Build a Linux dedicated server and use a Linux base such as ubuntu:22.04.', finalFrom.line);
      }
      if (image && image !== 'scratch' && !image.includes('$') && (!/[:@]/.test(image.split('/').pop() ?? '') || image.endsWith(':latest'))) {
        warn('unpinned-base', `Base image "${image}" is unpinned or uses "latest", so rebuilds are not reproducible.`,
          'Pin a version, e.g. ubuntu:22.04.', finalFrom.line);
      }
    }

    const run = [...ins].reverse().find((i) => i.op === 'CMD' || i.op === 'ENTRYPOINT');
    if (!run) {
      err('no-cmd', 'No CMD or ENTRYPOINT: the container will exit as soon as it starts and the deployment will error.',
        'Add a CMD that launches the server binary in the foreground.');
    }
    const launch = ins.filter((i) => i.op === 'CMD' || i.op === 'ENTRYPOINT').map((i) => i.args).join(' ');

    if (/\.exe\b/i.test(ins.filter((i) => ['COPY', 'ADD', 'CMD', 'ENTRYPOINT'].includes(i.op)).map((i) => i.args).join(' '))) {
      err('windows-binary', 'The image copies or launches a .exe. Edgegap runs Linux containers, so a Windows build cannot start.',
        'Build the Linux dedicated server target (Unity: Linux Dedicated Server; Unreal: LinuxServer).');
    }

    if (/\b(127\.0\.0\.1|localhost)\b/.test(launch)) {
      warn('loopback-bind', 'The launch command mentions 127.0.0.1/localhost. A server bound to loopback is unreachable from outside the container.',
        'Bind to 0.0.0.0 (or omit the address so the server listens on all interfaces).', run?.line);
    }

    for (const e of ins.filter((i) => i.op === 'EXPOSE')) {
      for (const p of parseExpose(e.args)) {
        exposed.push({ ...p, line: e.line });
        if (p.port === 22) {
          warn('ssh-exposed', 'Port 22 (SSH) is exposed. Edgegap advises never exposing SSH in production images.',
            'Remove EXPOSE 22 and the sshd start-up from the production image.', e.line);
        }
      }
    }

    const users = ins.filter((i) => i.op === 'USER');
    const finalUser = users[users.length - 1]?.args.split(':')[0];
    const runsAsRoot = !finalUser || finalUser === 'root' || finalUser === '0';

    if (engine === 'unity') {
      if (run && !/-batchmode/.test(launch)) {
        warn('unity-no-batchmode', 'Unity server launched without -batchmode.', 'Append "-batchmode -nographics" to the server command.', run.line);
      }
      if (run && !/-nographics/.test(launch)) {
        warn('unity-no-nographics', 'Unity server launched without -nographics; it may try to initialise a GPU the container does not have.',
          'Append "-nographics" to the server command.', run.line);
      }
      if (!/chmod\s+(\+x|[0-7]*[157][0-7]{0,2})/.test(text)) {
        warn('no-chmod', 'No "chmod +x" on the server binary. Builds copied from Windows often lose the executable bit, giving "permission denied" at start.',
          'Add "RUN chmod +x /path/to/ServerBuild".');
      }
    }

    if (engine === 'unreal') {
      if (runsAsRoot) {
        err('unreal-root', 'The container runs as root. Unreal Engine servers refuse to start as root and exit immediately.',
          'Create a user (RUN useradd -m server) and add "USER server" before CMD.', users[users.length - 1]?.line);
      }
      if (/\.sh\b/.test(launch) && !/sed\s+-i\s+['"]?s\/\\r\$\/\/|dos2unix/.test(text)) {
        warn('crlf-script', 'The start script is not normalised to LF line endings. Scripts saved on Windows fail with "bad interpreter" or "not found".',
          "Add \"RUN sed -i 's/\\r$//' /app/StartServer.sh\" after the COPY.");
      }
    }

    if (engine === 'godot' && run && !/--headless/.test(launch)) {
      warn('godot-no-headless', 'Godot server launched without --headless.', 'Add "--headless" to the server command.', run.line);
    }
  }

  // ----------------------------------------------------------------- Ports --
  const ports = input.ports;
  if (ports !== undefined) {
    if (ports.length === 0) {
      err('no-ports', 'No ports configured. Players cannot connect to a version with no ports.', 'Add the port the server listens on, e.g. {port: 7777, protocol: "UDP"}.');
    }
    const seenPorts = new Map<number, number>();
    const seenNames = new Set<string>();
    ports.forEach((p, idx) => {
      const proto = p.protocol.toUpperCase();
      if (!(PROTOCOLS as readonly string[]).includes(proto)) {
        err('bad-protocol', `ports[${idx}].protocol "${p.protocol}" is not one Edgegap accepts.`, `Use one of: ${PROTOCOLS.join(', ')}.`);
      }
      if (!Number.isInteger(p.port) || p.port < 1 || p.port > 59999) {
        err('port-range', `ports[${idx}].port ${p.port} is outside 1-59999.`, 'Use the internal port the server listens on inside the container.');
      }
      if (seenPorts.has(p.port)) {
        err('duplicate-port', `Port ${p.port} is listed twice.`, 'Use one entry with protocol "TCP/UDP" if the server needs both.');
      }
      seenPorts.set(p.port, idx);
      const name = p.name ?? 'gameport';
      if (seenNames.has(name)) {
        err('duplicate-port-name', `Port name "${name}" is used twice. Deployment ports are keyed by name, so one would hide the other.`,
          'Give every port a distinct name, e.g. "gameport" and "webport".');
      }
      seenNames.add(name);
      if (p.tls_upgrade && proto !== 'WS' && proto !== 'HTTP') {
        err('tls-wrong-protocol', `ports[${idx}] has tls_upgrade on a ${p.protocol} port. Edgegap only offers TLS Upgrade on WS and HTTP ports.`,
          'Use protocol "WS" for a WebSocket server, or drop tls_upgrade.');
      }
    });

    if (input.netcode) {
      const expected = NETCODE_PROTOCOL[input.netcode.toLowerCase()];
      if (!expected) {
        warn('unknown-netcode', `Netcode "${input.netcode}" is not one this check knows.`, `Known values: ${NETCODE_NAMES.join(', ')}.`);
      } else if (ports.length > 0 && !ports.some((p) => {
        const proto = p.protocol.toUpperCase();
        return proto === expected || (proto === 'TCP/UDP' && (expected === 'UDP' || expected === 'TCP')) || (expected === 'WS' && proto === 'WSS');
      })) {
        err('netcode-protocol', `${input.netcode} speaks ${expected}, but no configured port uses ${expected}. Clients will time out connecting.`,
          `Set the game port's protocol to ${expected}.`);
      } else if (expected === 'WS') {
        // WebSocket transports are what browser (WebGL) builds use, and a
        // browser on an https page refuses plain ws://.
        for (const p of ports) {
          if (p.protocol.toUpperCase() === 'WS' && !p.tls_upgrade) {
            warn('ws-no-tls', `Port ${p.port} is WebSocket without tls_upgrade. Browser (WebGL) clients need wss://, which needs Edgegap's TLS Upgrade.`,
              'Set tls_upgrade: true on this port in edgegap_create_app_version, unless no client runs in a browser.');
          }
        }
      }
    }

    // Cross-check EXPOSE against the version ports. EXPOSE is documentation,
    // so a mismatch is not fatal on its own, but it is the best signal we have
    // for "the server listens on a different port than the version exposes".
    if (exposed.length > 0) {
      for (const p of ports) {
        const match = exposed.find((e) => e.port === p.port);
        if (!match) {
          warn('port-not-exposed', `Port ${p.port} is configured on the version but not EXPOSEd in the Dockerfile, which suggests the server listens elsewhere.`,
            `Confirm the server listens on ${p.port}, and add "EXPOSE ${p.port}/${p.protocol.toUpperCase() === 'UDP' ? 'udp' : 'tcp'}".`);
        } else if (!carries(p.protocol, match.protocol)) {
          warn('protocol-mismatch', `Dockerfile exposes ${p.port}/${match.protocol.toLowerCase()} but the version configures it as ${p.protocol}.`,
            'Make the two agree; the version setting is the one Edgegap uses.', match.line);
        }
      }
      for (const e of exposed) {
        if (e.port !== 22 && !ports.some((p) => p.port === e.port)) {
          warn('exposed-not-configured', `Dockerfile exposes ${e.port}/${e.protocol.toLowerCase()} but no version port maps it, so players cannot reach it.`,
            `Add {port: ${e.port}, protocol: "${e.protocol}"} to the version ports if clients need it.`, e.line);
        }
      }
    }
  }

  // ------------------------------------------------------------- Resources --
  if (input.cpu_units !== undefined && input.cpu_units < 256) {
    err('cpu-too-low', `cpu_units ${input.cpu_units} is below the 256 minimum.`, 'Use at least 256 (1024 = 1 vCPU).');
  }
  if (input.memory_mb !== undefined && input.memory_mb < 256) {
    err('memory-too-low', `memory_mb ${input.memory_mb} is below the 256 minimum.`, 'Use at least 256.');
  }
  if (input.cpu_units !== undefined && input.memory_mb !== undefined && input.memory_mb > input.cpu_units * 2) {
    err('memory-ratio', `memory_mb (${input.memory_mb}) exceeds twice cpu_units (${input.cpu_units}). Edgegap rejects this.`,
      `Lower memory_mb to ${input.cpu_units * 2} or raise cpu_units.`);
  }

  // ----------------------------------------------------------------- Image --
  // Same rules edgegap_create_app_version enforces, so the validator never
  // passes a version that the create tool then refuses.
  const tagProblem = input.docker_tag === undefined ? undefined : badTag(input.docker_tag);
  if (tagProblem) {
    err('latest-tag', `${tagProblem}. Edgegap caches images by tag, so a re-pushed tag can deploy a stale build.`,
      'Tag every build uniquely, e.g. a build ID or timestamp.');
  }
  const imageProblem = input.docker_image === undefined ? undefined : badImage(input.docker_repository ?? '', input.docker_image);
  if (imageProblem) {
    err('image-reference', imageProblem, 'docker_image is the path only; the registry and tag have their own fields.');
  }
  if (input.docker_repository?.includes('registry.edgegap.com') && input.docker_image && !input.docker_image.includes('/')) {
    err('missing-project', `docker_image "${input.docker_image}" has no project prefix. Images on registry.edgegap.com live under your project.`,
      'Use "<project>/<image>"; edgegap_get_registry_credentials returns the project name.');
  }
  if (input.docker_repository && /^https?:\/\//.test(input.docker_repository)) {
    err('repository-scheme', `docker_repository "${input.docker_repository}" includes a URL scheme.`, 'Use the bare host, e.g. "registry.edgegap.com".');
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  return { engine, errors, warnings };
}
