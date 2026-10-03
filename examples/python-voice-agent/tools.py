"""The protected back-office tools. Each one consumes its grant before it acts.

`@guarded` makes the function callable only as fn(grant_id, conversation_id, params):
the gateway must confirm a single-use grant for exactly these parameters first.
"""
from anticlus import ToolClient, guarded

GATEWAY = "http://127.0.0.1:8787"
tool = ToolClient(GATEWAY, "demo-tool-key")

SUPPLIERS = {"acme": {"iban": "BE68539007547034", "phone": "+3225550101"}}


@guarded(tool, "update_supplier_iban")
def update_supplier_iban(params: dict) -> str:
    SUPPLIERS["acme"]["iban"] = params["iban"]
    return f"ERP: supplier account is now {params['iban']}"


@guarded(tool, "update_contact_person")
def update_contact_person(params: dict) -> str:
    SUPPLIERS["acme"]["phone"] = params["phone"]
    return f"ERP: supplier phone is now {params['phone']}"
