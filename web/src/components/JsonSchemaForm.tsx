import { useState, type JSX } from "react";

interface JsonSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: (string | number)[];
  properties?: Record<string, JsonSchemaProperty>;
}

interface JsonSchemaFormProps {
  schema: { properties?: Record<string, JsonSchemaProperty> } | undefined;
  value: unknown;
  onSubmit: (value: Record<string, unknown>) => void;
}

type FormObject = Record<string, unknown>;

function isFormObject(value: unknown): value is FormObject {
  return typeof value === "object" && value !== null;
}

/** What an input shows for a value: config fields are strings, numbers and booleans. */
function inputText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function cloneValue<T>(value: T): T {
  return value === undefined || value === null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function coerceEnumValue(propSchema: JsonSchemaProperty, raw: string): string | number {
  if (propSchema.type === "number" || propSchema.type === "integer") {
    return Number(raw);
  }
  return raw;
}

/**
 * Minimal hand-rolled form renderer for a flat-ish JSON Schema (string/number/
 * boolean/enum, at most one level of nested object). Intentionally not a full
 * JSON Schema form library — good enough for a handful of plugin config fields.
 */
export function JsonSchemaForm({ schema, value, onSubmit }: JsonSchemaFormProps): JSX.Element {
  const [state, setState] = useState<FormObject>(() => {
    const initial = cloneValue(value);
    return isFormObject(initial) ? initial : {};
  });

  const properties: Record<string, JsonSchemaProperty> = schema?.properties ?? {};

  function getFieldValue(path: string[]): unknown {
    let target: unknown = state;
    for (const key of path) {
      target = isFormObject(target) ? target[key] : undefined;
    }
    return target;
  }

  function updateField(path: string[], fieldValue: unknown): void {
    setState((prev) => {
      const next = cloneValue(prev);
      let target: FormObject = next;
      for (let i = 0; i < path.length - 1; i++) {
        const child = target[path[i]];
        if (!isFormObject(child)) {
          target[path[i]] = {};
        }
        target = target[path[i]] as FormObject;
      }
      target[path[path.length - 1]] = fieldValue;
      return next;
    });
  }

  function renderField(key: string, propSchema: JsonSchemaProperty, parentPath: string[]) {
    const path = [...parentPath, key];
    const fieldId = path.join(".");
    const currentValue = getFieldValue(path);
    const label = propSchema.title ?? key;

    // A map or list (e.g. the WING box map) has no flat form; it is edited through its own tool/route.
    // Not rendering it leaves its value untouched in `state`, so saving the form keeps it as-is.
    if ((propSchema.type === "object" && !propSchema.properties) || propSchema.type === "array") {
      return null;
    }

    if (propSchema.type === "object" && propSchema.properties) {
      return (
        <fieldset key={fieldId} className="json-schema-form__group">
          <legend>{label}</legend>
          {Object.entries(propSchema.properties).map(([childKey, childSchema]) =>
            renderField(childKey, childSchema, path),
          )}
        </fieldset>
      );
    }

    if (propSchema.enum) {
      return (
        <label key={fieldId} className="json-schema-form__field">
          <span>{label}</span>
          <select
            value={inputText(currentValue)}
            onChange={(event) => updateField(path, coerceEnumValue(propSchema, event.target.value))}
          >
            <option value="" disabled>
              Select...
            </option>
            {propSchema.enum.map((option) => (
              <option key={String(option)} value={String(option)}>
                {String(option)}
              </option>
            ))}
          </select>
        </label>
      );
    }

    if (propSchema.type === "boolean") {
      return (
        <label key={fieldId} className="json-schema-form__field json-schema-form__field--checkbox">
          <input
            type="checkbox"
            checked={Boolean(currentValue)}
            onChange={(event) => updateField(path, event.target.checked)}
          />
          <span>{label}</span>
        </label>
      );
    }

    if (propSchema.type === "number" || propSchema.type === "integer") {
      return (
        <label key={fieldId} className="json-schema-form__field">
          <span>{label}</span>
          <input
            type="number"
            step={propSchema.type === "integer" ? 1 : "any"}
            value={inputText(currentValue)}
            onChange={(event) =>
              updateField(path, event.target.value === "" ? undefined : Number(event.target.value))
            }
          />
        </label>
      );
    }

    return (
      <label key={fieldId} className="json-schema-form__field">
        <span>{label}</span>
        <input
          type="text"
          value={inputText(currentValue)}
          onChange={(event) => updateField(path, event.target.value)}
        />
      </label>
    );
  }

  return (
    <form
      className="json-schema-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(state);
      }}
    >
      {Object.entries(properties).map(([key, propSchema]) => renderField(key, propSchema, []))}
      <button type="submit" className="json-schema-form__save">
        Save
      </button>
    </form>
  );
}
