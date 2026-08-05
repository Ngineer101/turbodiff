-- Per-repo verification gate for factory runs (fixer + generator): a shell
-- command (typically install + typecheck/tests) that must succeed in the
-- sandbox before any generated or fixed code is pushed. NULL disables the gate.
ALTER TABLE repositories ADD COLUMN check_command TEXT;
