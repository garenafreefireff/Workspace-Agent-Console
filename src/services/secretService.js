const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const TEMPLATE_PATTERN = /\{\{(secret|capture|env):([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const WHOLE_TEMPLATE_PATTERN = /^\{\{(secret|capture|env):([A-Za-z_][A-Za-z0-9_]*)\}\}$/;
const SENSITIVE_KEY_PATTERN = /(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|client[_-]?secret)/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi;
const AUTHORIZATION_SCHEME_PATTERN = /((?:authorization)\s*[=:]\s*)(Bearer|Basic)\s+([^\s,"';}]+)/gi;
const RAW_AUTHORIZATION_PATTERN = /((?:authorization)\s*[=:]\s*)((?!(?:Bearer|Basic)\b)[^\s,"';}]+)/gi;
const SENSITIVE_ASSIGNMENT_PATTERN = /((?:password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)\s*[=:]\s*)(["']?)([^\s,"';}]+)(\2)/gi;

export function assertSecretRef(secretRef) {
  if (typeof secretRef !== "string" || !SECRET_REF_PATTERN.test(secretRef)) {
    throw new Error(`Secret ref khong hop le: ${String(secretRef)}`);
  }
  return secretRef;
}

export function resolveSecret(secretRef, env = process.env) {
  assertSecretRef(secretRef);
  const value = env[secretRef];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Secret env chua duoc cau hinh: ${secretRef}`);
  }

  return value;
}

export function collectSecretRefs(value, output = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE_PATTERN)) {
      if (match[1] === "secret") {
        output.add(assertSecretRef(match[2]));
      }
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSecretRefs(item, output);
    }
    return output;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "secretRef" && typeof item === "string") {
        output.add(assertSecretRef(item));
      } else {
        collectSecretRefs(item, output);
      }
    }
  }

  return output;
}

export function resolveSecretValues(secretRefs, env = process.env) {
  const values = [];

  for (const ref of secretRefs ?? []) {
    values.push(resolveSecret(ref, env));
  }

  return values;
}

function lookupTemplateValue(kind, name, context) {
  if (kind === "secret") {
    const value = resolveSecret(name, context.env);
    context.sensitiveValues?.add(value);
    return value;
  }

  if (kind === "capture") {
    if (!Object.prototype.hasOwnProperty.call(context.captures ?? {}, name)) {
      throw new Error(`Capture chua ton tai: ${name}`);
    }
    return context.captures[name];
  }

  const value = context.env?.[name];
  if (typeof value !== "string") {
    throw new Error(`Env chua duoc cau hinh: ${name}`);
  }
  return value;
}

export function renderTemplate(value, context = {}) {
  const normalizedContext = {
    env: context.env ?? process.env,
    captures: context.captures ?? {},
    sensitiveValues: context.sensitiveValues,
  };

  if (typeof value === "string") {
    const whole = value.match(WHOLE_TEMPLATE_PATTERN);
    if (whole) {
      return lookupTemplateValue(whole[1], whole[2], normalizedContext);
    }

    return value.replace(TEMPLATE_PATTERN, (_match, kind, name) => {
      const resolved = lookupTemplateValue(kind, name, normalizedContext);
      if (resolved === null || resolved === undefined) {
        return "";
      }
      if (typeof resolved === "object") {
        return JSON.stringify(resolved);
      }
      return String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderTemplate(item, normalizedContext));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderTemplate(item, normalizedContext),
      ])
    );
  }

  return value;
}

function redactString(value, secretValues) {
  let output = value;

  for (const secret of secretValues) {
    if (typeof secret !== "string" || secret.length < 4) {
      continue;
    }
    output = output.split(secret).join("[REDACTED]");
  }

  output = output.replace(
    AUTHORIZATION_SCHEME_PATTERN,
    (_match, prefix, scheme) => `${prefix}${scheme} [REDACTED]`
  );
  output = output.replace(
    RAW_AUTHORIZATION_PATTERN,
    (_match, prefix) => `${prefix}[REDACTED]`
  );
  output = output.replace(BEARER_PATTERN, "$1[REDACTED]");
  output = output.replace(JWT_PATTERN, "[REDACTED_JWT]");
  output = output.replace(
    SENSITIVE_ASSIGNMENT_PATTERN,
    (_match, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`
  );
  return output;
}

export function sanitizeEvidence(value, secretValues = []) {
  const normalizedSecrets = [...new Set(secretValues)]
    .filter((item) => typeof item === "string" && item.length >= 4)
    .sort((left, right) => right.length - left.length);
  const seen = new WeakSet();

  function sanitize(current, key = "") {
    if (current === null || current === undefined) {
      return current;
    }

    if (typeof current === "string") {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        return "[REDACTED]";
      }
      return redactString(current, normalizedSecrets);
    }

    if (typeof current !== "object") {
      return current;
    }

    if (seen.has(current)) {
      return "[CIRCULAR]";
    }
    seen.add(current);

    if (Array.isArray(current)) {
      return current.map((item) => sanitize(item));
    }

    const output = {};
    for (const [childKey, childValue] of Object.entries(current)) {
      if (SENSITIVE_KEY_PATTERN.test(childKey)) {
        output[childKey] = "[REDACTED]";
      } else {
        output[childKey] = sanitize(childValue, childKey);
      }
    }
    return output;
  }

  return sanitize(value);
}

export function sanitizeText(value, secretValues = []) {
  return redactString(String(value ?? ""), secretValues);
}
