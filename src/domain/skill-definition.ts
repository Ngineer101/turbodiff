export interface SkillDefinitionValues {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly instructions: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSkillSlug(slug: string): string | null {
  return slug.length >= 2 && slug.length <= 31 && SLUG.test(slug)
    ? null
    : 'slug must be 2-31 chars: lowercase letters and digits separated by single dashes';
}

export function validateSkillDefinition(values: SkillDefinitionValues): string | null {
  if (!values.name) return 'name is required';
  if (!values.instructions) return 'instructions are required';
  return null;
}
