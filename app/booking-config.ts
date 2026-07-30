const formspreeEndpointPattern =
  /^https:\/\/formspree\.io\/f\/[A-Za-z0-9_-]+$/;

export function resolveBookingEndpoint(value?: string): string {
  const endpoint = value?.trim() ?? "";
  return formspreeEndpointPattern.test(endpoint) ? endpoint : "";
}

export function resolveBookingScriptSrc(basePath = ""): string {
  const normalizedBasePath =
    basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  return `${normalizedBasePath}/booking-form.js`;
}
