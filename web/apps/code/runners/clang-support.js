// Small compatibility layer so typical lab programs (Turbo C / Dev-C++ habits) compile with Clang+WASI.

export const COMPAT_H = `/* FoCT Virtual Labs: included automatically */
#ifndef FOCT_COMPAT_H
#define FOCT_COMPAT_H
#if !defined(__cplusplus) && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
char *gets(char *) __attribute__((deprecated("gets() is unsafe, prefer fgets(buf, sizeof buf, stdin)")));
#endif
#endif
`;

export const CONIO_H = `/* conio.h for FoCT Virtual Labs (subset of the Turbo C / Windows API) */
#ifndef FOCT_CONIO_H
#define FOCT_CONIO_H
#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
int getch(void);
int getche(void);
int kbhit(void);
void clrscr(void);
void gotoxy(int x, int y);
void textcolor(int color);
void textbackground(int color);
int putch(int c);
int cputs(const char *s);
int cprintf(const char *format, ...);
#ifdef __cplusplus
}
#endif
enum COLORS { BLACK, BLUE, GREEN, CYAN, RED, MAGENTA, BROWN, LIGHTGRAY, DARKGRAY,
              LIGHTBLUE, LIGHTGREEN, LIGHTCYAN, LIGHTRED, LIGHTMAGENTA, YELLOW, WHITE };
#endif
`;

export const DOS_H = `/* dos.h for FoCT Virtual Labs */
#ifndef FOCT_DOS_H
#define FOCT_DOS_H
#include <unistd.h>
#ifdef __cplusplus
extern "C" {
#endif
void delay(unsigned int milliseconds);
#ifdef __cplusplus
}
#endif
#endif
`;

export const WINDOWS_H = `/* windows.h for FoCT Virtual Labs: only Sleep() is available in the browser */
#ifndef FOCT_WINDOWS_H
#define FOCT_WINDOWS_H
#ifdef __cplusplus
extern "C" {
#endif
void Sleep(unsigned long milliseconds);
#ifdef __cplusplus
}
#endif
#endif
`;

const STD_HEADERS = [
  "cassert", "cctype", "cerrno", "cfloat", "climits", "clocale", "cmath", "cstdarg",
  "cstddef", "cstdio", "cstdlib", "cstring", "ctime", "cwchar", "cwctype", "cinttypes", "cstdint", "cfenv",
  "algorithm", "array", "bitset", "chrono", "complex", "deque", "exception", "fstream", "functional",
  "initializer_list", "iomanip", "ios", "iosfwd", "iostream", "istream", "iterator", "limits", "list",
  "locale", "map", "memory", "new", "numeric", "optional", "ostream", "queue", "random", "ratio", "regex",
  "set", "sstream", "stack", "stdexcept", "streambuf", "string", "string_view", "system_error", "tuple",
  "type_traits", "typeindex", "typeinfo", "unordered_map", "unordered_set", "utility", "valarray",
  "variant", "vector", "any", "charconv", "bit", "compare", "concepts", "numbers", "span", "ranges",
];
export const BITS_STDCPP_H = `/* bits/stdc++.h for FoCT Virtual Labs (libc++, no threads) */
#ifndef FOCT_BITS_STDCPP_H
#define FOCT_BITS_STDCPP_H
${STD_HEADERS.map((h) => `#include <${h}>`).join("\n")}
#endif
`;

export const RT_C = `/* FoCT Virtual Labs runtime support, linked into every program */
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <unistd.h>

__attribute__((import_module("foct"), import_name("system")))
extern int __foct_host_system(const char *command);

/* Show prompts such as printf("Enter n: ") before the program waits for input. */
__attribute__((constructor)) static void __foct_init(void) { setvbuf(stdout, NULL, _IONBF, 0); }

int system(const char *command) { return __foct_host_system(command); }

char *gets(char *s) {
    int c; char *p = s;
    while ((c = getchar()) != EOF && c != '\\n') *p++ = (char)c;
    if (c == EOF && p == s) return NULL;
    *p = 0;
    return s;
}

int getch(void) { return getchar(); }
int getche(void) { return getchar(); }
int kbhit(void) { return 0; }
void clrscr(void) { fputs("\\x1b[2J\\x1b[H", stdout); }
void gotoxy(int x, int y) { (void)x; (void)y; }
void textcolor(int c) { (void)c; }
void textbackground(int c) { (void)c; }
int putch(int c) { return putchar(c); }
int cputs(const char *s) { return fputs(s, stdout); }
int cprintf(const char *fmt, ...) { va_list ap; va_start(ap, fmt); int n = vprintf(fmt, ap); va_end(ap); return n; }
void delay(unsigned int ms) { usleep(ms * 1000u); }
void Sleep(unsigned long ms) { usleep((useconds_t)(ms * 1000u)); }
`;

/* Wraps main() of C++ programs: WebAssembly exceptions that nobody catches would otherwise
   leave the program silently; print what g++ programs print and exit like abort(). */
export const EH_WRAPPER_CPP = `#include <exception>
#include <typeinfo>
#include <cstdio>
#include <cxxabi.h>

extern "C" int __real___main_void(void);

static void foct_report(const char *raw, const char *what) {
    int status = 0;
    char *name = raw ? abi::__cxa_demangle(raw, nullptr, nullptr, &status) : nullptr;
    std::fflush(stdout);
    std::fprintf(stderr, "terminate called after throwing an instance of '%s'\\n",
                 status == 0 && name ? name : (raw ? raw : "unknown"));
    if (what) std::fprintf(stderr, "  what():  %s\\n", what);
}

extern "C" int __wrap___main_void(void) {
    try {
        return __real___main_void();
    } catch (const std::exception &e) {
        foct_report(typeid(e).name(), e.what());
    } catch (...) {
        std::type_info *t = abi::__cxa_current_exception_type();
        foct_report(t ? t->name() : nullptr, nullptr);
    }
    return 134;
}
`;

export const INCLUDE_DIR = {
  "foct_compat.h": COMPAT_H,
  "conio.h": CONIO_H,
  "dos.h": DOS_H,
  "windows.h": WINDOWS_H,
  bits: { "stdc++.h": BITS_STDCPP_H },
};
