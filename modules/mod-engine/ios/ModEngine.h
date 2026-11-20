// Exposes the C engine API (cpp/mod_engine.h, shared with Android) to Swift.
// Keep these in sync with that header.
#include <stddef.h>

typedef struct ModEngine ModEngine;

ModEngine *me_new(size_t memory_limit, int budget_ms);
void me_free(ModEngine *e);
char *me_load(ModEngine *e, const char *files_json, const char *entry);
char *me_call(ModEngine *e, const char *name, const char *args_json);
void me_free_string(char *s);
