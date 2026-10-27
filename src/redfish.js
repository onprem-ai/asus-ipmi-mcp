// Read-only info and power control via Redfish (AMI Redfish server on the BMC).
import { normalizeVersion } from './firmware.js';

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

export async function systemInfo(bmc) {
  const [mgr, sys, chassis] = await Promise.all([
    bmc.redfish('GET', '/redfish/v1/Managers/Self'),
    bmc.redfish('GET', '/redfish/v1/Systems/Self'),
    bmc.redfish('GET', '/redfish/v1/Chassis/Self').catch(() => ({})),
  ]);
  const bmcInfo = pick(mgr, ['Model', 'FirmwareVersion', 'Status', 'DateTime', 'UUID']);
  // Redfish spells the version "1.01.35"; the web API and the ASUS support page "1.1.35".
  if (bmcInfo.FirmwareVersion) bmcInfo.firmware_version = normalizeVersion(bmcInfo.FirmwareVersion);
  return {
    bmc: bmcInfo,
    host: pick(sys, ['Manufacturer', 'Model', 'PowerState', 'BiosVersion', 'Status', 'IndicatorLED', 'Boot']),
    chassis: pick(chassis, ['ChassisType', 'Manufacturer', 'Model', 'PowerState', 'Status']),
    note: !sys.BiosVersion ? 'Host BIOS/model fields are empty: typical when the motherboard runs a BIOS without IPMI support (ASUS calls for a special IPMI BIOS).' : undefined,
  };
}

export async function sensors(bmc, { includeAbsent = false } = {}) {
  const [thermal, power] = await Promise.all([
    bmc.redfish('GET', '/redfish/v1/Chassis/Self/Thermal').catch(() => ({})),
    bmc.redfish('GET', '/redfish/v1/Chassis/Self/Power').catch(() => ({})),
  ]);
  const keep = (s) => includeAbsent || s?.Status?.State !== 'Absent';
  const out = {
    temperatures: (thermal.Temperatures || []).filter(keep).map((t) => ({ name: t.Name, celsius: t.ReadingCelsius, state: t.Status?.State, health: t.Status?.Health })),
    fans: (thermal.Fans || []).filter(keep).map((f) => ({ name: f.Name, reading: f.Reading, units: f.ReadingUnits, state: f.Status?.State })),
    voltages: (power.Voltages || []).filter(keep).map((v) => ({ name: v.Name, volts: v.ReadingVolts, state: v.Status?.State })),
  };
  const total = (thermal.Temperatures || []).length + (thermal.Fans || []).length + (power.Voltages || []).length;
  out.summary = `${out.temperatures.length + out.fans.length + out.voltages.length} of ${total} sensors present` +
    (total && !out.temperatures.length && !out.fans.length && !out.voltages.length
      ? ' (all absent: connect fans/sensors to the card, and/or install the IPMI-enabled motherboard BIOS)'
      : '');
  return out;
}

export const POWER_ACTIONS = ['On', 'ForceOff', 'GracefulShutdown', 'ForceRestart'];

export async function power(bmc, action) {
  if (!POWER_ACTIONS.includes(action)) throw new Error(`action must be one of ${POWER_ACTIONS.join(', ')}`);
  await bmc.redfish('POST', '/redfish/v1/Systems/Self/Actions/ComputerSystem.Reset', { ResetType: action });
  const sys = await bmc.redfish('GET', '/redfish/v1/Systems/Self');
  return { requested: action, powerStateNow: sys.PowerState };
}

/** One-time boot override, e.g. "Cd", "Pxe", "Usb", "Hdd", "BiosSetup". */
export async function setBootOnce(bmc, target, mode) {
  const body = { Boot: { BootSourceOverrideEnabled: 'Once', BootSourceOverrideTarget: target } };
  if (mode) body.Boot.BootSourceOverrideMode = mode;
  await bmc.redfish('PATCH', '/redfish/v1/Systems/Self', body);
  const sys = await bmc.redfish('GET', '/redfish/v1/Systems/Self');
  return pick(sys.Boot || {}, ['BootSourceOverrideEnabled', 'BootSourceOverrideTarget', 'BootSourceOverrideMode']);
}
