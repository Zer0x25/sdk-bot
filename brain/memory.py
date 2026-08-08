# Memoria de conversación en RAM por user_id
memory_db = {}

MAX_HISTORY_MESSAGES = 15

def get_history(user_id: str):
    if user_id not in memory_db:
        memory_db[user_id] = []
    return memory_db[user_id]

def update_history(user_id: str, history: list):
    # Truncate history to avoid token overflow and memory leaks
    if len(history) > MAX_HISTORY_MESSAGES:
        memory_db[user_id] = history[-MAX_HISTORY_MESSAGES:]
    else:
        memory_db[user_id] = history

def clear_history(user_id: str):
    if user_id in memory_db:
        del memory_db[user_id]
        return True
    return False
