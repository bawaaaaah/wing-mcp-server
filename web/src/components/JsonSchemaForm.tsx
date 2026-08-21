import { useState } from "react";

interface JsonSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  properties?: Record<string, JsonSchemaProperty>;
}

interface JsonSchemaFormProps {
  schema: any;
  value: any;
  onSubmit: (value: any) => void;
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
export function JsonSchemaForm({ schema, value, onSubmit }: JsonSchemaFormProps) {
  const [state, setState] = useState<Record<string, unknown>>(() => cloneValue(value) ?? {});

  const properties: Record<string, JsonSchemaProperty> = schema?.properties ?? {};

  function getFieldValue(path: string[]): unknown {
    let target: any = state;
    for (const key of path) {
      target = target?.[key];
    }
    return target;
  }

  function updateField(path: string[], fieldValue: unknown): void {
    setState((prev) => {
      const next: any = cloneValue(prev);
      let target: any = next;
      for (let i = 0; i < path.length - 1; i++) {
        if (typeof target[path[i]] !== "object" || target[path[i]] === null) {
          target[path[i]] = {};
        }
        target = target[path[i]];
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

    if (propSchema.type === "object" && propSchema.properties) {
      return (
        <fieldset key={fieldId} className="json-schema-form__group">
          <legend>{label}</legend>
          {Object.entries(propSchema.properties).map(([childKey, childSchema]) =>
            renderField(childKey, childSchema, path)
          )}
        </fieldset>
      );
    }

    if (propSchema.enum) {
      return (
        <label key={fieldId} className="json-schema-form__field">
          <span>{label}</span>
          <select
            value={currentValue === undefined || currentValue === null ? "" : String(currentValue)}
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
            value={currentValue === undefined || currentValue === null ? "" : String(currentValue)}
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
          value={currentValue === undefined || currentValue === null ? "" : String(currentValue)}
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
