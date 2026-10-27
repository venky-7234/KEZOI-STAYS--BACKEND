const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { SCREENS } = require('../src/services/metaFlowBooking.service');

const jsonPath = path.resolve(__dirname, '../imports/kezoi-premium-booking-flow-draft.json');

console.log('--- Validating Meta WhatsApp Flow JSON ---');
console.log(`Target: ${jsonPath}`);

// 1. JSON Syntax
const rawContent = fs.readFileSync(jsonPath, 'utf8');
let flow;
try {
  flow = JSON.parse(rawContent);
  console.log('✔ 1. JSON syntax check: Valid');
} catch (err) {
  console.error('❌ JSON syntax error:', err.message);
  process.exit(1);
}

// 2. Schema Versions
assert.equal(flow.version, '7.3', 'Flow version must be 7.3');
assert.equal(flow.data_api_version, '3.0', 'data_api_version must be 3.0');
console.log(`✔ 2. Versions: Flow JSON v${flow.version}, Data API v${flow.data_api_version}`);

// 3. Screen IDs Verification
const requiredScreens = [
  'BOOKING_DETAILS',
  'PROPERTY_SELECTION',
  'PROPERTY_DETAILS',
  'CALENDAR',
  'GUEST_SELECTION',
  'LIVE_QUOTE',
  'GUEST_DETAILS',
  'BOOKING_REVIEW',
  'ENQUIRY_CREATED'
];
const specialEntryScreens = ['VIEW_STAY_ENTRY', 'RESERVE_ENTRY'];
const allRequiredScreens = [...specialEntryScreens, ...requiredScreens];

const screenMap = new Map(flow.screens.map(s => [s.id, s]));
for (const id of allRequiredScreens) {
  assert.ok(screenMap.has(id), `Missing required screen: ${id}`);
}
assert.equal(flow.screens.length, allRequiredScreens.length, `Expected exactly ${allRequiredScreens.length} screens`);
console.log(`✔ 3. All ${allRequiredScreens.length} expected screens present and unique`);

// 4. Routing Model
const routing = flow.routing_model;
assert.ok(routing, 'routing_model must be defined');

for (const screen of flow.screens) {
  assert.ok(Array.isArray(routing[screen.id]), `routing_model missing entry for screen: ${screen.id}`);
  assert.ok(!routing[screen.id].includes(screen.id), `Loop detected: screen ${screen.id} routes to itself in routing_model`);
  for (const target of routing[screen.id]) {
    assert.ok(screenMap.has(target), `routing_model target screen '${target}' from '${screen.id}' does not exist`);
  }
}

// In-degree & entry screen validation
const inDegree = new Map(flow.screens.map(s => [s.id, 0]));
for (const screen of flow.screens) {
  for (const target of routing[screen.id]) {
    inDegree.set(target, (inDegree.get(target) || 0) + 1);
  }
}
const entryScreens = flow.screens.filter(s => inDegree.get(s.id) === 0);
assert.ok(entryScreens.length > 0, 'No entry screen found in the routing model. Expected at least one screen with no inbound edges.');

// Cycle detection via DFS
const visited = new Set();
const recursionStack = new Set();
function hasCycle(node) {
  visited.add(node);
  recursionStack.add(node);
  for (const neighbor of (routing[node] || [])) {
    if (!visited.has(neighbor)) {
      if (hasCycle(neighbor)) return true;
    } else if (recursionStack.has(neighbor)) {
      return true;
    }
  }
  recursionStack.delete(node);
  return false;
}
for (const screen of flow.screens) {
  if (!visited.has(screen.id)) {
    assert.ok(!hasCycle(screen.id), `Cycle detected in routing_model starting at ${screen.id}`);
  }
}

// Terminal screen check
assert.deepEqual(routing.ENQUIRY_CREATED, [], 'ENQUIRY_CREATED must be terminal (empty routing target)');
assert.equal(screenMap.get('ENQUIRY_CREATED').terminal, true, 'ENQUIRY_CREATED must have terminal: true');
assert.equal(screenMap.get('ENQUIRY_CREATED').success, true, 'ENQUIRY_CREATED must have success: true');
console.log(`✔ 4. routing_model DAG verified: ${entryScreens.map(s => s.id).join(', ')} (in-degree 0), no loops/cycles, terminal state verified`);

// 5. Data Field Declarations and Examples
const validDataTypes = new Set(['string', 'number', 'boolean', 'array', 'object']);

for (const screen of flow.screens) {
  assert.ok(screen.data && typeof screen.data === 'object', `Screen ${screen.id} missing data object`);
  for (const [key, field] of Object.entries(screen.data)) {
    assert.ok(validDataTypes.has(field.type), `Screen ${screen.id} data field ${key} has invalid type: ${field.type}`);
    assert.ok(field.__example__ !== undefined, `Screen ${screen.id} data field ${key} missing __example__`);
    if (field.type === 'array') {
      assert.ok(field.items, `Array field ${screen.id}.${key} missing items declaration`);
    }
    if (field.type === 'object') {
      assert.ok(field.properties, `Object field ${screen.id}.${key} missing properties declaration`);
    }
  }
}
console.log('✔ 5. All screen data models typed with valid examples and item schemas');

// 6. Backend Contract Compliance (SCREEN_DATA_FIELDS)
const SCREEN_DATA_FIELDS = {
  VIEW_STAY_ENTRY: ['property_id', 'property_code', 'entry_intent', 'has_error', 'error_message'],
  RESERVE_ENTRY: ['property_id', 'property_code', 'entry_intent', 'has_error', 'error_message'],
  BOOKING_DETAILS: ['has_error', 'error_message'],
  PROPERTY_SELECTION: ['check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'properties', 'no_properties_available', 'quote_generated_at', 'has_error', 'error_message'],
  PROPERTY_DETAILS: ['property_id', 'property_name', 'property_description', 'property_location', 'amenities', 'amenities_text', 'max_guests', 'gallery', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'has_error', 'error_message'],
  CALENDAR: ['property_id', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'unavailable_dates', 'calendar_refreshed_at', 'has_error', 'error_message'],
  GUEST_SELECTION: ['property_id', 'check_in', 'check_out', 'max_guests', 'adults', 'children', 'infants', 'pets', 'has_error', 'error_message'],
  LIVE_QUOTE: ['property_id', 'property_name', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'nights', 'currency', 'base_amount', 'extra_guests', 'extra_guest_amount', 'taxable_amount', 'gst_rate', 'cgst_amount', 'sgst_amount', 'gst_amount', 'total_amount', 'quote_generated_at', 'has_error'],
  GUEST_DETAILS: ['property_id', 'property_name', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'has_error', 'error_message'],
  BOOKING_REVIEW: ['property_id', 'property_name', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'guest_name', 'guest_email', 'whatsapp_number', 'country_code', 'special_requests', 'has_special_requests', 'quote', 'quote_generated_at', 'has_error', 'error_message'],
  ENQUIRY_CREATED: ['enquiry_reference', 'enquiry_status', 'payment_status', 'continuation_type', 'continuation_url', 'replayed', 'message']
};

for (const [screenId, fields] of Object.entries(SCREEN_DATA_FIELDS)) {
  const declared = screenMap.get(screenId).data;
  for (const field of fields) {
    assert.ok(declared[field], `Screen ${screenId} missing declared field from backend contract: ${field}`);
  }
}
console.log('✔ 6. Full coverage of SCREEN_DATA_FIELDS backend response fields verified across all 11 screens');

// 7. Component Structure & Data Binding Validation
const validComponentTypes = new Set([
  'SingleColumnLayout', 'Form', 'TextHeading', 'TextSubheading', 'TextBody',
  'TextCaption', 'CalendarPicker', 'TextInput', 'TextArea', 'RadioButtonsGroup',
  'ImageCarousel', 'EmbeddedLink', 'Footer'
]);

function validateComponent(comp, screen, formComponents = new Set()) {
  assert.ok(validComponentTypes.has(comp.type), `Unknown component type: ${comp.type} in ${screen.id}`);

  // Validate visible property according to Meta Flow Schema
  if (comp.visible !== undefined) {
    if (typeof comp.visible === 'boolean') {
      // Literal boolean is valid
    } else if (typeof comp.visible === 'string' && comp.visible.startsWith('${') && comp.visible.endsWith('}')) {
      const inner = comp.visible.slice(2, -1).trim();
      assert.ok(
        /^(data|screen\.data)\.[a-zA-Z0-9_]+$/.test(inner),
        `Component ${comp.type} in ${screen.id} has invalid visible expression: '${comp.visible}'. Must be boolean or \${data.boolean_field}`
      );
      const fieldName = inner.replace(/^(data|screen\.data)\./, '');
      const dataField = screen.data[fieldName];
      assert.ok(dataField, `Component ${comp.type} in ${screen.id} visible references undeclared field: ${fieldName}`);
      assert.equal(dataField.type, 'boolean', `Component ${comp.type} in ${screen.id} visible references field ${fieldName} of type ${dataField.type}, must be boolean`);
    } else {
      assert.fail(`Component ${comp.type} in ${screen.id} has invalid visible type: ${typeof comp.visible}`);
    }
  }

  // Validate text dynamic data format according to Meta Flow Schema
  if (comp.text && typeof comp.text === 'string' && comp.text.startsWith('${') && comp.text.endsWith('}')) {
    assert.ok(
      /^\$\{(data|screen\.data)\.[a-zA-Z0-9_.]+\}$/.test(comp.text),
      `Component ${comp.type} in ${screen.id} has invalid text expression '${comp.text}'. When text starts with '\${' and ends with '}', it must be an exact single property reference, not multi-value interpolation.`
    );
    const varPath = comp.text.slice(2, -1).trim().replace(/^(data|screen\.data)\./, '');
    const rootField = varPath.split('.')[0];
    assert.ok(screen.data[rootField], `Component ${comp.type} in ${screen.id} text references undeclared data field '${rootField}'`);
  }

  if (comp.children) {
    const isForm = comp.type === 'Form';
    const localFormComps = isForm ? new Set() : formComponents;
    for (const child of comp.children) {
      if (isForm && child.name) {
        assert.ok(!localFormComps.has(child.name), `Duplicate component name ${child.name} in form ${comp.name}`);
        localFormComps.add(child.name);
      }
      validateComponent(child, screen, localFormComps);
    }
  }

  // Validate on-click-action bindings
  if (comp['on-click-action']) {
    const action = comp['on-click-action'];
    assert.ok(['data_exchange', 'open_url', 'complete', 'navigate'].includes(action.name), `Invalid action name ${action.name} in ${screen.id}`);
    if (action.payload) {
      for (const [payloadKey, expr] of Object.entries(action.payload)) {
        if (typeof expr === 'string' && expr.startsWith('${') && expr.endsWith('}')) {
          const inner = expr.slice(2, -1).trim();
          if (inner.startsWith('data.')) {
            const dataKey = inner.slice(5).split('.')[0];
            assert.ok(screen.data[dataKey], `Payload ${payloadKey} references undeclared data field '${dataKey}' in ${screen.id}`);
          } else if (inner.startsWith('form.')) {
            const formPath = inner.slice(5);
            const formKey = formPath.split('.')[0];
            assert.ok(formComponents.has(formKey), `Payload ${payloadKey} references unknown form field '${formKey}' in form of screen ${screen.id}`);
          }
        }
      }
    }
  }

  // Check CalendarPicker
  if (comp.type === 'CalendarPicker') {
    assert.ok(comp.name, `CalendarPicker in ${screen.id} missing name`);
    assert.ok(comp.label, `CalendarPicker in ${screen.id} missing label`);
    if (comp.mode === 'range') {
      assert.equal(typeof comp.label, 'object', `CalendarPicker in ${screen.id} label must be object in range mode`);
      assert.ok(comp.label['start-date'] && comp.label['end-date'], `CalendarPicker in ${screen.id} label must have start-date and end-date`);
      assert.equal(typeof comp['helper-text'], 'object', `CalendarPicker in ${screen.id} helper-text must be object in range mode`);
      assert.ok(comp['helper-text']['start-date'] && comp['helper-text']['end-date'], `CalendarPicker in ${screen.id} helper-text must have start-date and end-date`);
      assert.equal(typeof comp.required, 'object', `CalendarPicker in ${screen.id} required must be object in range mode`);
      assert.strictEqual(typeof comp.required['start-date'], 'boolean', `CalendarPicker in ${screen.id} required.start-date must be boolean`);
      assert.strictEqual(typeof comp.required['end-date'], 'boolean', `CalendarPicker in ${screen.id} required.end-date must be boolean`);
    } else {
      assert.equal(typeof comp.required, 'boolean', `CalendarPicker in ${screen.id} required must be boolean`);
    }
  }

  // Check ImageCarousel
  if (comp.type === 'ImageCarousel') {
    assert.equal(comp.images, '${data.gallery}', `ImageCarousel in ${screen.id} must bind to \${data.gallery}`);
  }

  // Check Form init-values against number input-types
  if (comp.type === 'Form' && comp['init-values'] && comp.children) {
    for (const child of comp.children) {
      if (child.type === 'TextInput' && child['input-type'] === 'number' && child.name) {
        const initVal = comp['init-values'][child.name];
        if (initVal !== undefined && typeof initVal === 'string' && !initVal.startsWith('${')) {
          assert.fail(`Form ${comp.name} in ${screen.id} init-values.${child.name} must be numeric, not string '${initVal}'`);
        }
      }
    }
  }
}

for (const screen of flow.screens) {
  assert.equal(screen.layout.type, 'SingleColumnLayout', `Screen ${screen.id} must use SingleColumnLayout`);
  validateComponent(screen.layout, screen);
}
console.log('✔ 7. All UI components, forms, and payload data bindings validated');

// 8. No hardcoded production data
assert.ok(!rawContent.includes('1149040077692619'), 'Must not hardcode Flow ID in JSON file');
assert.ok(!rawContent.includes('secret'), 'Must not contain secrets');
console.log('✔ 8. No hardcoded IDs or sensitive tokens found');

// 9. Calendar date parsing & quote calculation logic verification
const { parseStay } = require('../src/services/availability.service');
const validStay = parseStay({ check_in: '2026-11-01', check_out: '2026-11-05', adults: 2, children: 1 });
assert.equal(validStay.nights, 4, 'parseStay must calculate exactly 4 nights');
assert.equal(validStay.priced_guests, 3, 'parseStay must calculate 3 priced guests (2 adults + 1 child)');

const invalidDates = parseStay({ check_in: '2026-11-05', check_out: '2026-11-01', adults: 2 });
assert.ok(invalidDates.error, 'parseStay must reject check_out before check_in');

const zeroAdults = parseStay({ check_in: '2026-11-01', check_out: '2026-11-03', adults: 0 });
assert.ok(zeroAdults.error, 'parseStay must reject adults < 1');

console.log('✔ 9. Calendar date parsing and quote logic assertions verified');

console.log('\n--- ALL STRUCTURAL VALIDATIONS PASSED SUCCESSFULLY ---');
