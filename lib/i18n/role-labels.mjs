import { SYSTEM_ROLES, PRESET_ROLES } from '../authz/permissions.mjs';

const defaults = new Map([...SYSTEM_ROLES, ...PRESET_ROLES].map(role => [role.key, role]));

/** Only unchanged built-in copy is localized. Renamed/custom roles stay authored. */
export function roleDisplayText(tUi, role, field = 'name') {
  const value = role?.[field];
  const definition = defaults.get(role?.key);
  const builtIn = role?.origin === 'system' || role?.origin === 'preset' || role?.isSystem;
  return builtIn && definition && value === definition[field] ? tUi(value) : value;
}
