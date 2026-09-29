-- Safe to run again: only inserts fictional, explicitly marked demo records.
BEGIN;

INSERT INTO patients (
  full_name, gender, date_of_birth, phone, whatsapp, email, referral_source,
  status, registration_date, allergies, medical_conditions, dental_complaints, is_demo
)
SELECT 'Mariam Adel (Demo)', 'female', '1992-08-14', '01000000001', '01000000001',
  'mariam.demo@example.test', 'Instagram', 'active', now() - interval '40 days',
  'Penicillin', 'None reported', 'Routine check-up', true
WHERE NOT EXISTS (SELECT 1 FROM patients WHERE phone = '01000000001' AND is_demo = true);

INSERT INTO patients (
  full_name, gender, date_of_birth, phone, whatsapp, referral_source,
  status, registration_date, dental_complaints, is_demo
)
SELECT 'Omar Hassan (Demo)', 'male', '1987-11-05', '01000000002', '01000000002',
  'Patient referral', 'active', now() - interval '12 days',
  'Sensitivity in upper molar', true
WHERE NOT EXISTS (SELECT 1 FROM patients WHERE phone = '01000000002' AND is_demo = true);

INSERT INTO patients (
  full_name, gender, date_of_birth, phone, referral_source,
  status, registration_date, dental_complaints, is_demo
)
SELECT 'Nour El Din (Demo)', 'female', '2000-03-21', '01000000003',
  'Google', 'active', now(), 'Consultation for whitening', true
WHERE NOT EXISTS (SELECT 1 FROM patients WHERE phone = '01000000003' AND is_demo = true);

INSERT INTO appointments (patient_id, doctor_name, treatment, starts_at, ends_at, status, is_demo)
SELECT p.id, 'Dr. Hossam (Demo)', 'Consultation',
  ((now() AT TIME ZONE 'Africa/Cairo')::date + time '09:30') AT TIME ZONE 'Africa/Cairo',
  ((now() AT TIME ZONE 'Africa/Cairo')::date + time '10:00') AT TIME ZONE 'Africa/Cairo',
  'scheduled', true
FROM patients p
WHERE p.phone = '01000000001' AND p.is_demo = true
  AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.is_demo = true);

INSERT INTO appointments (patient_id, doctor_name, treatment, starts_at, ends_at, status, is_demo)
SELECT p.id, 'Dr. Hossam (Demo)', 'Filling',
  ((now() AT TIME ZONE 'Africa/Cairo')::date + time '11:15') AT TIME ZONE 'Africa/Cairo',
  ((now() AT TIME ZONE 'Africa/Cairo')::date + time '12:00') AT TIME ZONE 'Africa/Cairo',
  'confirmed', true
FROM patients p
WHERE p.phone = '01000000002' AND p.is_demo = true
  AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.is_demo = true);

INSERT INTO appointments (patient_id, doctor_name, treatment, starts_at, ends_at, status, is_demo)
SELECT p.id, 'Dr. Salma (Demo)', 'Whitening consultation',
  ((now() AT TIME ZONE 'Africa/Cairo')::date + time '14:00') AT TIME ZONE 'Africa/Cairo',
  ((now() AT TIME ZONE 'Africa/Cairo')::date + time '14:30') AT TIME ZONE 'Africa/Cairo',
  'cancelled', true
FROM patients p
WHERE p.phone = '01000000003' AND p.is_demo = true
  AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.is_demo = true);

INSERT INTO payments (patient_id, amount_cents, method, paid_at, is_demo)
SELECT p.id, 85000, 'cash', now(), true
FROM patients p
WHERE p.phone = '01000000001' AND p.is_demo = true
  AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.patient_id = p.id AND x.is_demo = true);

INSERT INTO expenses (category, supplier, amount_cents, occurred_at, is_demo)
SELECT 'Dental materials (Demo)', 'Demo supplier', 17500, now(), true
WHERE NOT EXISTS (SELECT 1 FROM expenses WHERE category = 'Dental materials (Demo)' AND is_demo = true);

INSERT INTO invoices (patient_id, total_cents, paid_cents, status, is_demo)
SELECT p.id, 150000, 85000, 'partial', true
FROM patients p
WHERE p.phone = '01000000001' AND p.is_demo = true
  AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.patient_id = p.id AND i.is_demo = true);

INSERT INTO suppliers (name, phone, notes, is_demo)
SELECT 'Demo Dental Supply Co.', '01000000990', 'Fictional supplier for sample inventory', true
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE name = 'Demo Dental Supply Co.' AND is_demo = true);

INSERT INTO inventory_items (
  name, sku, unit, quantity_on_hand, reorder_level, unit_cost_cents, supplier_id, is_demo
)
SELECT 'Examination gloves M (Demo)', 'DEMO-GLOVES-M', 'box', 12, 20, 4200, s.id, true
FROM suppliers s WHERE s.name = 'Demo Dental Supply Co.' AND s.is_demo = true
ON CONFLICT (sku) DO NOTHING;

INSERT INTO inventory_items (
  name, sku, unit, quantity_on_hand, reorder_level, unit_cost_cents, supplier_id, is_demo
)
SELECT 'Surgical masks (Demo)', 'DEMO-MASKS', 'box', 48, 10, 3100, s.id, true
FROM suppliers s WHERE s.name = 'Demo Dental Supply Co.' AND s.is_demo = true
ON CONFLICT (sku) DO NOTHING;

INSERT INTO stock_movements (item_id, delta, reason, note)
SELECT i.id, i.quantity_on_hand, 'receive', 'Opening demo balance'
FROM inventory_items i
WHERE i.is_demo = true AND i.sku IN ('DEMO-GLOVES-M', 'DEMO-MASKS')
  AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.item_id = i.id);

COMMIT;