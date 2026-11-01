export function qualifies(paths) {
  return paths.some((path) => !(
    path.endsWith(".md") || path.startsWith("docs/") || path === ".gitignore"
  ));
}
