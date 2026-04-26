# Python Data Quality Pipeline

Create a scaffold for a Python data quality pipeline package named `data_quality_pipeline`.

Required deliverables:

1. `pyproject.toml`
   - include dependencies `typer`, `pydantic`, `polars`
   - include `pytest` in a test extra or dependency group
2. `src/data_quality_pipeline/cli.py`
   - expose a Typer app
   - implement commands `run` and `inspect`
3. `src/data_quality_pipeline/validators.py`
   - define `SchemaRule`
   - define at least one validator function
4. `docs/architecture.md`
   - include sections:
     - `## Pipeline stages`
     - `## Validation contracts`
     - `## Output artifacts`
5. `README.md`
   - include an operator checklist
   - mention batch inputs and failed-row outputs

Constraints:

- Do not install packages or execute tests.
- Keep the layout implementation-oriented and easy to extend.
