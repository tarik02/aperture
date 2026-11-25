import * as Migrator from "effect/sql/Migrator";
import initial from "./0001_initial.ts";
import v1Credentials from "./0002_v1_credentials.ts";

/**
 * What was done to the database, in the order it was done, a file each. One that was
 * released is never changed: what comes after is another file, named by the next number,
 * and added here. They are named here and not read from the directory, as the program is
 * packed into one file.
 */
const migrations = {
  "0001_initial": initial,
  "0002_v1_credentials": v1Credentials,
};

/** Brings the database to what this program expects; what was applied before is left alone. */
export const migrate = Migrator.make({})({
  loader: Migrator.fromRecord(migrations),
  table: "control_migrations",
});
