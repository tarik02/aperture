export function run(state) {
  if (location.origin !== state.origin) return;
  sessionStorage.clear();
  for (const entry of state.entries) sessionStorage.setItem(entry.name, entry.value);
}
