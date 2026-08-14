/**
 * Several carriers publish their claim form under a locale-parameterised path
 * — Lufthansa's `/{market}/{lang}/…`, SWISS's the same shape, Iberia's
 * `/{lang}/…`. The dataset records both the template and the concrete
 * substitution that was actually verified, because in every case only ONE
 * market/language combination was confirmed to respond; the rest are presumed
 * equivalent but unchecked.
 *
 * Substitution happens once at load time so nothing downstream carries a
 * half-built URL around.
 */

/** The only placeholders a template may use. Anything else is a data error. */
export const TEMPLATE_PLACEHOLDERS = ["market", "lang"] as const;

export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

export class UnresolvedUrlTemplateError extends Error {
  constructor(template: string, unresolved: string[]) {
    super(`URL template "${template}" still contains unsubstituted placeholder(s): ${unresolved.join(", ")}`);
    this.name = "UnresolvedUrlTemplateError";
  }
}

/** Every placeholder present in a template, in order of first appearance. */
export function placeholdersIn(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !found.includes(name)) {
      found.push(name);
    }
  }
  return found;
}

/**
 * Substitutes every placeholder, and THROWS if any survives. A URL containing a
 * literal "{market}" must never reach a passenger — it would look like a real
 * link and 404, which is worse than admitting we don't have one. The adapter
 * constructor is the right place to die.
 */
export function resolveTemplatedUrl(template: string, values: Readonly<Record<string, string>>): string {
  const resolved = template.replace(PLACEHOLDER_PATTERN, (whole, name: string) => values[name] ?? whole);

  const unresolved = placeholdersIn(resolved);
  if (unresolved.length > 0) {
    throw new UnresolvedUrlTemplateError(template, unresolved);
  }
  return resolved;
}
