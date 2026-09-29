import assert from "node:assert/strict";
import test from "node:test";
import { canWriteClinicalHistory, countsAsAttending, isNoShow } from "../src/lib/clinicPolicy.ts";

test("only clinical writers can change patient medical and dental history", () => {
  for (const role of ["owner", "dentist"]) assert.equal(canWriteClinicalHistory(role), true, role);
  for (const role of ["manager", "reception", "assistant", "accountant"]) {
    assert.equal(canWriteClinicalHistory(role), false, role);
  }
});

test("both current and legacy no-show statuses are excluded from attendance", () => {
  for (const status of ["no_show", "no-show"]) {
    assert.equal(isNoShow(status), true, status);
    assert.equal(countsAsAttending(status), false, status);
  }
  assert.equal(countsAsAttending("cancelled"), false);
  for (const status of ["scheduled", "confirmed", "arrived", "completed"]) {
    assert.equal(isNoShow(status), false, status);
    assert.equal(countsAsAttending(status), true, status);
  }
});