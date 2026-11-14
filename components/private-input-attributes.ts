// Astryx TextInput exposes a native-input ref, but not these native attributes.
// Keep secret fields out of spellchecking and retain the existing input bounds.
export function apiKeyAttributes(input: HTMLInputElement | null) {
  if (!input) return;
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  input.maxLength = 4096;
}
export function spinAttributes(input: HTMLInputElement | null) {
  if (!input) return;
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  input.maxLength = 128;
}
export function vinAttributes(input: HTMLInputElement | null) {
  if (!input) return;
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "characters");
  input.maxLength = 17;
  input.minLength = 17;
  input.pattern = "[A-HJ-NPR-Z0-9]{17}";
}
