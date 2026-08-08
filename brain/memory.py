# Memoria de conversación en RAM por user_id
memory_db = {}

function_get_history = lambda user_id: memory_db.setdefault(user_id, [])

def get_history(user_id: str):
    if user_id not in memory_db:
        memory_db[user_id] = []
    return memory_db[user_id]

def update_history(user_id: str, history):
    memory_db[user_id] = history
