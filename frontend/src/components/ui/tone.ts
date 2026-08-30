export const inferTone = (s: string) =>
  s === "success"
    ? "success"
    : s === "warning"
      ? "warning"
      : s === "error"
        ? "danger"
        : "info";
