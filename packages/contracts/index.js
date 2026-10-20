'use strict';

const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const schema = require('./schema.json');
const utf8 = new TextEncoder();

// Pure validation: never coerce IDs, strip fields, apply defaults or mutate input.
const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addFormat('unicode-text', {
  type: 'string',
  validate: (value) => value.isWellFormed(),
});
ajv.addKeyword({
  keyword: 'x-maxUtf8Bytes',
  type: 'string',
  schemaType: 'number',
  metaSchema: { type: 'integer', minimum: 0 },
  validate: (limit, value) => utf8.encode(value).byteLength <= limit,
  errors: false,
});
ajv.addSchema(schema);
const validators = new Map(Object.keys(schema.$defs).map((name) => [
  name, ajv.getSchema(`${schema.$id}#/$defs/${name}`),
]));

/** Validation errors intentionally omit input values and arbitrary provider data. */
function validate(name, value) {
  const validator = validators.get(name);
  if (!validator) throw new TypeError(`Unknown contract: ${name}`);
  if (validator(value)) return { valid: true, value };
  const errors = validator.errors.map(({ instancePath, schemaPath, keyword }) => ({
    instancePath, schemaPath, keyword,
  }));
  return { valid: false, errors };
}

function assertValid(name, value) {
  const result = validate(name, value);
  if (result.valid) return result.value;
  const error = new TypeError(`Invalid contract: ${name}`);
  error.errors = result.errors;
  throw error;
}

module.exports = { validate, assertValid };
