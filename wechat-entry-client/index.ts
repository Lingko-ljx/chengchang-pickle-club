import {
  PUBLIC_CHANNEL_QUERY_PARAMETER,
  resolvePublicChannelSource,
  sanitizePublicChannelPath,
} from "../app/wechat-entry";

const STORAGE_KEY = "ruiancheng-public-channel-v1";

function querySource() {
  const params = new URLSearchParams(window.location.search);
  const values = params.getAll(PUBLIC_CHANNEL_QUERY_PARAMETER);
  return {
    present: values.length > 0,
    source: values.length === 1 ? resolvePublicChannelSource(values[0]) : null,
  };
}

function storedSource() {
  try {
    return resolvePublicChannelSource(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function rememberSource(source: string | null) {
  try {
    if (source) window.sessionStorage.setItem(STORAGE_KEY, source);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Privacy modes may disable storage; URL propagation still works.
  }
}

function preserveParameters(node: Element) {
  return (node.getAttribute("data-preserve-public-channel") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function rewriteAttribute(
  node: Element,
  attribute: string,
  source: string,
  allowedParameters: readonly string[] = [],
) {
  const target = node.getAttribute(attribute);
  if (!target) return;
  try {
    node.setAttribute(
      attribute,
      sanitizePublicChannelPath(
        target,
        window.location.href,
        source,
        allowedParameters,
      ),
    );
  } catch {
    // Marked links are expected to be same-origin. Fail closed if they are not.
  }
}

const requested = querySource();
if (requested.present && !requested.source) rememberSource(null);
const source = requested.source ?? (!requested.present ? storedSource() : null);

if (source) {
  rememberSource(source);
  document.documentElement.setAttribute("data-public-channel-source", source);

  const page = document.querySelector("[data-public-channel-page]");
  if (page) page.setAttribute("data-public-channel-source", source);

  const links = document.querySelectorAll("[data-preserve-public-channel]");
  for (let index = 0; index < links.length; index += 1) {
    rewriteAttribute(links[index], "href", source, preserveParameters(links[index]));
  }

  const form = document.getElementById("booking-form");
  if (form) {
    rewriteAttribute(form, "data-booking-result-path", source);
    rewriteAttribute(form, "data-booking-status-path", source);
  }
}
