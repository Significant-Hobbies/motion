export function countSwiftFormatDiagnostics(result) {
  const diagnostics = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /\.swift:\d+:\d+: error:/u.test(line)).length;
  if (result.error) throw result.error;
  if (
    ![0, 1].includes(result.status) ||
    (result.status === 1 && diagnostics === 0)
  ) {
    throw new Error(
      `Swift format exited ${result.status} without valid lint diagnostics.`
    );
  }
  return diagnostics;
}
