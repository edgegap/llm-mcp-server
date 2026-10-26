/**
 * Image and env var rules shared by the write tools and the validator.
 *
 * Edgegap caches images by tag. A re-pushed "latest" (or any tag that moves)
 * can deploy a stale build, and two deployments of the same version can run
 * different code. Agents reach for "latest" by default, so it is refused, not
 * just discouraged.
 */

/** Docker's tag grammar: up to 128 characters, no leading dot or dash. */
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Why a tag cannot be used, or undefined when it can. */
export function badTag(tag: string): string | undefined {
  const t = tag.trim();
  if (t === '') return 'docker_tag is empty, which Docker treats as "latest"';
  if (t.toLowerCase() === 'latest') return `docker_tag "${tag}" moves with every push`;
  if (!TAG_RE.test(tag)) {
    return `docker_tag "${tag.slice(0, 40)}" is not a valid Docker tag (letters, digits, "_", "." and "-", up to 128, not starting with "." or "-")`;
  }
  return undefined;
}

export const TAG_FIX =
  'Edgegap caches images by tag, so a moving tag can deploy a stale build. Push the image ' +
  'with a unique tag (a build ID, commit SHA or timestamp) and use that tag.';

/**
 * Why docker_image is malformed, or undefined. The API takes the image in
 * three fields; agents often put a whole reference in docker_image instead.
 */
export function badImage(repository: string, image: string): string | undefined {
  const img = image.trim();
  if (img === '') return 'docker_image is empty.';
  const first = img.split('/')[0];
  const last = img.split('/').pop() ?? '';
  const hasHost = img.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  const tagAt = last.search(/[:@]/);
  if (!hasHost && tagAt === -1) return undefined;

  const host = hasHost ? first : repository.trim() || '<registry>';
  const path = (hasHost ? img.slice(first.length + 1) : img).replace(/[:@].*$/, '');
  const tag = tagAt === -1 ? '<build-id>' : last.slice(tagAt + 1).replace(/^sha256:.*/, '<build-id>');
  return (
    `docker_image "${img.slice(0, 80)}" holds more than the image path. Split it: ` +
    `docker_repository "${host}", docker_image "${path}", docker_tag "${tag}".`
  );
}

/**
 * Env var names that usually carry a secret. Their values are sent with
 * is_hidden, so the dashboard does not show them in plain text.
 */
const SECRET_NAME_RE = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH/i;

export function looksSecret(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/**
 * What GET /v1/app/{app}/version(s) return in place of private_username,
 * private_token and every is_secret env value (live API, 2026-10-26). Sent
 * back, it becomes the stored value, and image pulls fail with "Unable to
 * login".
 */
export const ENCRYPTED_PLACEHOLDER = 'This value is set and encrypted';

export function isEncryptedPlaceholder(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === ENCRYPTED_PLACEHOLDER.toLowerCase();
}
