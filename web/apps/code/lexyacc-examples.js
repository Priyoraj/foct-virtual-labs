// Lex & Yacc lab: the language entry, starter programs and examples (classic compiler-design labs).
// Written with String.raw so that backslashes in patterns (\n, \t, \.) stay exactly as typed.

const WORDCOUNT_L = String.raw`%{
/* Count lines, words and characters.
   Type some text, then press Ctrl+D to end the input. */
#include <stdio.h>
int chars = 0, words = 0, lines = 0;
%}

%%
[a-zA-Z0-9]+    { words++; chars += yyleng; }
\n              { lines++; chars++; }
.               { chars++; }
%%

int yywrap(void) { return 1; }

int main(void)
{
    yylex();
    printf("Lines: %d  Words: %d  Characters: %d\n", lines, words, chars);
    return 0;
}
`;

const TOKENS_L = String.raw`%{
/* A lexical analyser: classify the tokens of a small C-like language.
   Type some code (several lines are fine), then press Ctrl+D. */
#include <stdio.h>
int count = 0;
%}

digit   [0-9]
letter  [a-zA-Z_]

%%
"int"|"float"|"char"|"double"|"if"|"else"|"while"|"for"|"do"|"return"|"void"   { printf("%-12s %s\n", "KEYWORD", yytext); count++; }
{letter}({letter}|{digit})*      { printf("%-12s %s\n", "IDENTIFIER", yytext); count++; }
{digit}+"."{digit}+              { printf("%-12s %s\n", "FLOAT", yytext); count++; }
{digit}+                         { printf("%-12s %s\n", "INTEGER", yytext); count++; }
\"[^"\n]*\"                      { printf("%-12s %s\n", "STRING", yytext); count++; }
"=="|"!="|"<="|">="|"&&"|"||"    { printf("%-12s %s\n", "OPERATOR", yytext); count++; }
"++"|"--"|[-+*/%=<>!]            { printf("%-12s %s\n", "OPERATOR", yytext); count++; }
[;,(){}\[\]]                     { printf("%-12s %s\n", "PUNCTUATION", yytext); count++; }
"//".*                           { /* a comment: skipped */ }
"/*"([^*]|"*"+[^*/])*"*"+"/"     { /* a block comment: skipped */ }
[ \t\n]+                         { /* white space: skipped */ }
.                                { printf("%-12s %s\n", "UNKNOWN", yytext); }
%%

int yywrap(void) { return 1; }

int main(void)
{
    printf("Type C code, then press Ctrl+D:\n");
    yylex();
    printf("%d tokens\n", count);
    return 0;
}
`;

const VOWELS_L = String.raw`%{
/* Count vowels and consonants. Type text, then press Ctrl+D. */
#include <stdio.h>
int vowels = 0, consonants = 0;
%}

%%
[aeiouAEIOU]    { vowels++; }
[a-zA-Z]        { consonants++; }
.|\n            { /* anything else */ }
%%

int yywrap(void) { return 1; }

int main(void)
{
    yylex();
    printf("Vowels: %d  Consonants: %d\n", vowels, consonants);
    return 0;
}
`;

const CALC_L = String.raw`%{
/* Scanner for the calculator: numbers and single-character operators */
#include <stdlib.h>
#include "y.tab.h"
%}

%%
[0-9]+      { yylval = atoi(yytext); return NUMBER; }
[ \t]       { /* skip blanks */ }
\n          { return '\n'; }
.           { return yytext[0]; }
%%

int yywrap(void) { return 1; }
`;

const CALC_Y = String.raw`%{
/* A desk calculator with operator precedence.
   Type an expression and press Enter, for example   2 + 3 * (4 - 1)
   Ctrl+D ends the input. */
#include <stdio.h>
int yylex(void);
void yyerror(const char *s);
%}

%token NUMBER
%left '+' '-'
%left '*' '/' '%'
%right UMINUS

%%
input   : /* empty */
        | input line
        ;
line    : expr '\n'             { printf("= %d\n", $1); }
        | '\n'
        | error '\n'            { yyerrok; }
        ;
expr    : expr '+' expr         { $$ = $1 + $3; }
        | expr '-' expr         { $$ = $1 - $3; }
        | expr '*' expr         { $$ = $1 * $3; }
        | expr '/' expr         { if ($3 == 0) { yyerror("division by zero"); $$ = 0; } else $$ = $1 / $3; }
        | expr '%' expr         { $$ = $3 ? $1 % $3 : 0; }
        | '-' expr %prec UMINUS { $$ = -$2; }
        | '(' expr ')'          { $$ = $2; }
        | NUMBER
        ;
%%

void yyerror(const char *s) { fprintf(stderr, "error: %s\n", s); }

int main(void)
{
    printf("Calculator: type an expression and press Enter (Ctrl+D to quit)\n");
    return yyparse();
}
`;

const VALID_L = String.raw`%{
#include "y.tab.h"
%}

%%
[a-zA-Z_][a-zA-Z0-9_]*   { return ID; }
[0-9]+(\.[0-9]+)?        { return NUM; }
[-+*/()]                 { return yytext[0]; }
\n                       { return '\n'; }
[ \t]                    { }
.                        { return yytext[0]; }
%%

int yywrap(void) { return 1; }
`;

const VALID_Y = String.raw`%{
/* Is it a valid arithmetic expression? Type one per line, e.g.  a + b * (c - 2)
   Ctrl+D ends the input. */
#include <stdio.h>
int yylex(void);
void yyerror(const char *s);
%}

%token ID NUM
%left '+' '-'
%left '*' '/'

%%
input : /* empty */
      | input line
      ;
line  : e '\n'          { printf("Valid expression\n"); }
      | error '\n'      { printf("Invalid expression\n"); yyerrok; }
      | '\n'
      ;
e     : e '+' e | e '-' e | e '*' e | e '/' e
      | '(' e ')' | ID | NUM
      ;
%%

void yyerror(const char *s) { (void)s; /* reported by the error rule */ }

int main(void)
{
    printf("Type an arithmetic expression and press Enter:\n");
    return yyparse();
}
`;

const POSTFIX_L = String.raw`%{
#include <stdlib.h>
#include <string.h>
#include "y.tab.h"
%}

%%
[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+   { yylval.name = strdup(yytext); return OPERAND; }
[-+*/^()]                       { return yytext[0]; }
\n                              { return '\n'; }
[ \t]                           { }
.                               { return yytext[0]; }
%%

int yywrap(void) { return 1; }
`;

const POSTFIX_Y = String.raw`%{
/* Infix to postfix: type an expression such as  a + b * (c - d) ^ 2  and press Enter. */
#include <stdio.h>
int yylex(void);
void yyerror(const char *s);
%}

%union { char *name; }
%token <name> OPERAND
%left '+' '-'
%left '*' '/'
%right '^'

%%
input : /* empty */
      | input line
      ;
line  : e '\n'      { printf("\n"); }
      | error '\n'  { yyerrok; }
      | '\n'
      ;
e     : e '+' e     { printf("+ "); }
      | e '-' e     { printf("- "); }
      | e '*' e     { printf("* "); }
      | e '/' e     { printf("/ "); }
      | e '^' e     { printf("^ "); }
      | '(' e ')'
      | OPERAND     { printf("%s ", $1); }
      ;
%%

void yyerror(const char *s) { fprintf(stderr, "error: %s\n", s); }

int main(void)
{
    printf("Infix to postfix. Type an expression and press Enter:\n");
    return yyparse();
}
`;

const ANBN_L = String.raw`%{
#include "y.tab.h"
%}

%%
a       { return A; }
b       { return B; }
\n      { return '\n'; }
[ \t]   { }
.       { return OTHER; }
%%

int yywrap(void) { return 1; }
`;

const ANBN_Y = String.raw`%{
/* The language a^n b^n (n >= 1): aabb and ab are accepted, aab and ba are not.
   Type one string per line. */
#include <stdio.h>
int yylex(void);
void yyerror(const char *s);
%}

%token A B OTHER

%%
input : /* empty */
      | input line
      ;
line  : s '\n'      { printf("Accepted\n"); }
      | error '\n'  { printf("Rejected\n"); yyerrok; }
      ;
s     : A s B
      | A B
      ;
%%

void yyerror(const char *s) { (void)s; }

int main(void)
{
    printf("Type strings of a's and b's, one per line:\n");
    return yyparse();
}
`;

const TAC_L = String.raw`%{
#include <stdlib.h>
#include <string.h>
#include "y.tab.h"
%}

%%
[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+   { yylval.text = strdup(yytext); return ATOM; }
[-+*/=()]                       { return yytext[0]; }
\n                              { return '\n'; }
[ \t]                           { }
.                               { return yytext[0]; }
%%

int yywrap(void) { return 1; }
`;

const TAC_Y = String.raw`%{
/* Intermediate code: three-address code with temporaries t1, t2, ...
   Type an assignment such as   x = a + b * c - d / e   and press Enter. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int yylex(void);
void yyerror(const char *s);
static int temp = 0;

static char *newtemp(void)
{
    char buf[16];
    snprintf(buf, sizeof buf, "t%d", ++temp);
    return strdup(buf);
}

static char *emit(const char *op, char *a, char *b)
{
    char *t = newtemp();
    printf("    %s = %s %s %s\n", t, a, op, b);
    return t;
}
%}

%union { char *text; }
%token <text> ATOM
%type  <text> e
%left '+' '-'
%left '*' '/'
%right UMINUS

%%
input : /* empty */
      | input line
      ;
line  : ATOM '=' e '\n'     { printf("    %s = %s\n", $1, $3); temp = 0; }
      | e '\n'              { printf("    result in %s\n", $1); temp = 0; }
      | error '\n'          { yyerrok; temp = 0; }
      | '\n'
      ;
e     : e '+' e             { $$ = emit("+", $1, $3); }
      | e '-' e             { $$ = emit("-", $1, $3); }
      | e '*' e             { $$ = emit("*", $1, $3); }
      | e '/' e             { $$ = emit("/", $1, $3); }
      | '-' e %prec UMINUS  { char *t = newtemp(); printf("    %s = minus %s\n", t, $2); $$ = t; }
      | '(' e ')'           { $$ = $2; }
      | ATOM                { $$ = $1; }
      ;
%%

void yyerror(const char *s) { fprintf(stderr, "error: %s\n", s); }

int main(void)
{
    printf("Three-address code. Type an assignment and press Enter:\n");
    return yyparse();
}
`;

const NEW_L = String.raw`%{
#include <stdio.h>
%}

%%
.|\n    { ECHO; }
%%

int yywrap(void) { return 1; }

int main(void)
{
    yylex();
    return 0;
}
`;
const NEW_Y = String.raw`%{
#include <stdio.h>
int yylex(void);
void yyerror(const char *s);
%}

%token NUMBER

%%
start : NUMBER
      ;
%%

void yyerror(const char *s) { fprintf(stderr, "error: %s\n", s); }

int main(void)
{
    return yyparse();
}
`;

export const LEX_LANG = {
  id: "lex", name: "Lex & Yacc", title: "Lex & Yacc", monaco: "lex", ext: ".l", main: "wordcount.l",
  accept: ".l,.lex,.y,.yacc,.c,.h,.txt,.in,.dat", runner: "clang", template: WORDCOUNT_L,
  newFile: (n) => (/\.(l|lex)$/i.test(n) ? NEW_L : /\.(y|yacc)$/i.test(n) ? NEW_Y : /\.h$/i.test(n) ? "#pragma once\n\n" : ""),
  examples: {
    "Count lines, words and characters (lex)": { "wordcount.l": WORDCOUNT_L },
    "Lexical analyser: classify tokens (lex)": { "tokens.l": TOKENS_L },
    "Count vowels and consonants (lex)": { "vowels.l": VOWELS_L },
    "Calculator with precedence (lex + yacc)": { "calc.y": CALC_Y, "calc.l": CALC_L },
    "Is it a valid expression? (lex + yacc)": { "expr.y": VALID_Y, "expr.l": VALID_L },
    "Infix to postfix (lex + yacc)": { "postfix.y": POSTFIX_Y, "postfix.l": POSTFIX_L },
    "The language a^n b^n (lex + yacc)": { "anbn.y": ANBN_Y, "anbn.l": ANBN_L },
    "Three-address code generation (lex + yacc)": { "tac.y": TAC_Y, "tac.l": TAC_L },
  },
};

/** Syntax colouring for .l and .y files (C plus the lex/yacc sections, %directives and $$/$1). */
export function registerLexYacc(monaco) {
  const ckeywords = ["auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern",
    "float", "for", "goto", "if", "int", "long", "register", "return", "short", "signed", "sizeof", "static", "struct",
    "switch", "typedef", "union", "unsigned", "void", "volatile", "while", "ECHO", "BEGIN", "REJECT", "yytext", "yyleng",
    "yylval", "yyin", "yyout", "yyerrok", "yyclearin", "YYACCEPT", "YYABORT", "YYERROR"];
  const head = [
    [/\/\*/, "comment", "@comment"],
    [/\/\/.*$/, "comment"],
    [/^%%/, "keyword"],
    [/^%[{}]/, "keyword"],
    [/^%[a-zA-Z_]+/, "keyword"],
    [/%prec\b/, "keyword"],
    [/\$(\$|-?\d+|<\w+>(\$|-?\d+))/, "variable.predefined"],
    [/"([^"\\\n]|\\.)*"/, "string"],
    [/'([^'\\\n]|\\.)'/, "string"],
    [/^\s*#\s*\w+/, "keyword"],
  ];
  const tail = [
    [/\b\d+(\.\d+)?\b/, "number"],
    [/[A-Za-z_]\w*/, { cases: { "@ckeywords": "keyword", "@default": "identifier" } }],
  ];
  const comment = [[/[^*]+/, "comment"], [/\*\//, "comment", "@pop"], [/\*/, "comment"]];
  monaco.languages.register({ id: "lex", extensions: [".l", ".lex"] });
  monaco.languages.register({ id: "yacc", extensions: [".y", ".yacc"] });
  monaco.languages.setMonarchTokensProvider("lex", { ckeywords, tokenizer: {
    root: [...head, [/\{[A-Za-z_]\w*\}/, "type"], [/\[(\\.|[^\]\\\n])*\]/, "regexp"], [/<[A-Z_a-z]\w*>/, "type"], ...tail], comment } });
  monaco.languages.setMonarchTokensProvider("yacc", { ckeywords, tokenizer: { root: [...head, [/<\w+>/, "type"], ...tail], comment } });
  for (const id of ["lex", "yacc"]) {
    monaco.languages.setLanguageConfiguration(id, {
      comments: { lineComment: "//", blockComment: ["/*", "*/"] },
      brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
      autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: '"', close: '"', notIn: ["string"] }],
    });
  }
}
