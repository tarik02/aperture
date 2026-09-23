interface SessionStorageState {
  origin: string;
  entries: { name: string; value: string }[];
}

export function run(state: SessionStorageState): void {
  if (location.origin !== state.origin) return;
  sessionStorage.clear();
  for (const entry of state.entries) sessionStorage.setItem(entry.name, entry.value);
}
