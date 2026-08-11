import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMigrationDatabase,
  readMigrationConfiguration,
  readMigrationInputs,
  verifyBookingInventoryMigration,
} from "./migrate-booking-inventory-v2.mjs";

class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationError";
  }
}

function documents(response) {
  const values = Array.isArray(response?.data)
    ? response.data
    : response?.data
      ? [response.data]
      : [];
  return values.map((value) => {
    const result = { ...value };
    delete result._id;
    return result;
  });
}

export function hasReadyMigrationMarker(marker) {
  return (
    marker?.id === "booking-inventory-v2-migration" &&
    marker.status === "ready" &&
    marker.schemaVersion === 2 &&
    typeof marker.verifiedAt === "string" &&
    !Number.isNaN(new Date(marker.verifiedAt).getTime()) &&
    Number.isSafeInteger(marker.activeBookings) &&
    marker.activeBookings >= 0 &&
    Number.isSafeInteger(marker.reservations) &&
    marker.reservations >= 0 &&
    Number.isSafeInteger(marker.inventories) &&
    marker.inventories >= 0 &&
    typeof marker.inventoryChecksum === "string" &&
    /^[0-9a-f]{64}$/.test(marker.inventoryChecksum)
  );
}

export async function verifyCloudbaseBookingInventoryV2({
  environment = process.env,
  database,
} = {}) {
  const configuration = readMigrationConfiguration(environment);
  const resolvedDatabase = database ?? await createMigrationDatabase(configuration);
  const inputs = await readMigrationInputs(resolvedDatabase);
  const verification = verifyBookingInventoryMigration(inputs.bookings, inputs.inventories);
  if (!verification.valid) throw new VerificationError("BOOKING_INVENTORY_V2_INVALID");
  const marker = documents(
    await resolvedDatabase
      .collection("system_state")
      .doc("booking-inventory-v2-migration")
      .get(),
  )[0];
  if (!hasReadyMigrationMarker(marker)) {
    throw new VerificationError("BOOKING_INVENTORY_V2_NOT_READY");
  }
  return verification;
}

export function formatVerificationError(error) {
  return error instanceof VerificationError
    ? error.message
    : "CloudBase migration verification failed";
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    if (process.argv.length > 2) throw new VerificationError("INVALID_ARGUMENTS");
    const result = await verifyCloudbaseBookingInventoryV2();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(formatVerificationError(error));
    process.exitCode = 1;
  }
}
