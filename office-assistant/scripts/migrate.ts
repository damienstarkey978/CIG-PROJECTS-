import { closeDb, migrate } from "../src/lib/db";

migrate()
  .then((applied) => console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date"))
  .finally(closeDb);
