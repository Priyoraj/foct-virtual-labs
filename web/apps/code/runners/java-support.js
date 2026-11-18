// Java support for the browser compiler (javac + TeaVM):
//  - console input: System.in is routed to the page through foct.Stdin
//  - java.util.Scanner / InputMismatchException (missing from TeaVM) are provided as foct.*
//  - System.exit() ends the program cleanly
// Student sources are rewritten in place, keeping every line number unchanged.

export const SHIMS = {
  "NeedInput.java": `package foct;

/** Thrown when the program wants more keyboard input than has been typed so far. */
public final class NeedInput extends Error {
    public NeedInput() {
        super("waiting for keyboard input");
    }
}
`,
  "Stdin.java": `package foct;

import java.io.InputStream;
import java.io.Reader;

/** System.in for FoCT Virtual Labs: holds what the student has typed so far. */
public final class Stdin extends InputStream {
    public static final Stdin IN = new Stdin();
    private String text = "";
    private int pos;
    private boolean eof;
    private int[] pending = new int[4];
    private int pendingPos, pendingLen;

    private Stdin() {}

    public static void init(String text, boolean endOfInput) {
        IN.text = text;
        IN.pos = 0;
        IN.eof = endOfInput;
        IN.pendingPos = IN.pendingLen = 0;
    }

    /** Next character, -1 at end of input; asks for more typing when it runs out. */
    int readChar() {
        if (pos < text.length()) return text.charAt(pos++);
        if (eof) return -1;
        throw new NeedInput();
    }

    int availableChars() {
        return text.length() - pos;
    }

    @Override
    public int read() {
        if (pendingPos < pendingLen) return pending[pendingPos++];
        int c = readChar();
        if (c < 0x80) return c;
        if (Character.isHighSurrogate((char) c) && pos < text.length()) {
            c = Character.toCodePoint((char) c, text.charAt(pos++));
        }
        pendingPos = 0;
        if (c < 0x800) {
            pending[0] = 0xC0 | (c >> 6); pending[1] = 0x80 | (c & 0x3F); pendingLen = 2;
        } else if (c < 0x10000) {
            pending[0] = 0xE0 | (c >> 12); pending[1] = 0x80 | ((c >> 6) & 0x3F); pending[2] = 0x80 | (c & 0x3F); pendingLen = 3;
        } else {
            pending[0] = 0xF0 | (c >> 18); pending[1] = 0x80 | ((c >> 12) & 0x3F);
            pending[2] = 0x80 | ((c >> 6) & 0x3F); pending[3] = 0x80 | (c & 0x3F); pendingLen = 4;
        }
        return pending[pendingPos++];
    }

    @Override
    public int read(byte[] b, int off, int len) {
        if (len == 0) return 0;
        int c = read();
        if (c < 0) return -1;
        b[off] = (byte) c;
        int n = 1;
        while (n < len && b[off + n - 1] != 10 && (pendingPos < pendingLen || availableChars() > 0)) b[off + n++] = (byte) read();
        return n;
    }

    @Override
    public int available() {
        return (pendingLen - pendingPos) + availableChars();
    }

    /** Replacement for new InputStreamReader(System.in). */
    public static Reader reader() {
        return new Reader() {
            @Override
            public int read(char[] cbuf, int off, int len) {
                if (len == 0) return 0;
                int c = IN.readChar();
                if (c < 0) return -1;
                cbuf[off] = (char) c;
                int n = 1;
                while (n < len && cbuf[off + n - 1] != '\\n' && IN.availableChars() > 0) cbuf[off + n++] = (char) IN.readChar();
                return n;
            }

            @Override
            public void close() {}
        };
    }
}
`,
  "Utf8Reader.java": `package foct;

import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;

/** Minimal UTF-8 decoder (the browser runtime has no java.nio charsets). */
public final class Utf8Reader extends Reader {
    private final InputStream in;
    private int pendingLow = -1;

    public Utf8Reader(InputStream in) {
        this.in = in;
    }

    private int next() throws IOException {
        if (pendingLow >= 0) {
            int c = pendingLow;
            pendingLow = -1;
            return c;
        }
        int b = in.read();
        if (b < 0x80) return b;
        int need = b >= 0xF0 ? 3 : b >= 0xE0 ? 2 : 1;
        int cp = b & (0x3F >> need);
        for (int i = 0; i < need; i++) cp = (cp << 6) | (in.read() & 0x3F);
        if (cp >= 0x10000) {
            pendingLow = Character.lowSurrogate(cp);
            return Character.highSurrogate(cp);
        }
        return cp;
    }

    @Override
    public int read(char[] cbuf, int off, int len) throws IOException {
        if (len == 0) return 0;
        int c = next();
        if (c < 0) return -1;
        cbuf[off] = (char) c;
        int n = 1;
        while (n < len && (pendingLow >= 0 || in.available() > 0)) {
            c = next();
            if (c < 0) break;
            cbuf[off + n++] = (char) c;
        }
        return n;
    }

    @Override
    public void close() throws IOException {
        in.close();
    }
}
`,
  "Fmt.java": `package foct;

import java.io.PrintStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.Locale;

/** printf / String.format for the browser Java runtime (whose own Formatter is broken). */
public final class Fmt {
    private Fmt() {}

    public static PrintStream printf(PrintStream ps, String format, Object... args) {
        ps.print(format(format, args));
        ps.flush();
        return ps;
    }

    public static PrintStream printf(PrintStream ps, Locale l, String format, Object... args) {
        return printf(ps, format, args);
    }

    public static String format(Locale l, String format, Object... args) {
        return format(format, args);
    }

    public static String format(String f, Object... args) {
        if (args == null) args = new Object[] { null };
        StringBuilder out = new StringBuilder();
        int next = 0, last = -1, n = f.length();
        for (int i = 0; i < n; i++) {
            char c = f.charAt(i);
            if (c != '%') { out.append(c); continue; }
            int j = i + 1, k = j, index = -1;
            while (k < n && Character.isDigit(f.charAt(k))) k++;
            if (k < n && k > j && f.charAt(k) == '$') { index = Integer.parseInt(f.substring(j, k)) - 1; j = k + 1; }
            StringBuilder flags = new StringBuilder();
            while (j < n && "-#+ 0,(<".indexOf(f.charAt(j)) >= 0) flags.append(f.charAt(j++));
            int width = -1;
            k = j;
            while (k < n && Character.isDigit(f.charAt(k))) k++;
            if (k > j) { width = Integer.parseInt(f.substring(j, k)); j = k; }
            int prec = -1;
            if (j < n && f.charAt(j) == '.') {
                k = ++j;
                while (k < n && Character.isDigit(f.charAt(k))) k++;
                prec = k > j ? Integer.parseInt(f.substring(j, k)) : 0;
                j = k;
            }
            if (j >= n) throw new IllegalArgumentException("Format specifier '" + f.substring(i) + "' is incomplete");
            char conv = f.charAt(j);
            i = j;
            String fl = flags.toString();
            if (conv == 'n') { out.append('\\n'); continue; }
            if (conv == '%') { out.append(pad("%", width, fl, false)); continue; }
            Object arg;
            if (fl.indexOf('<') >= 0) {
                arg = args[last];
            } else {
                int at = index >= 0 ? index : next++;
                if (at >= args.length) throw new IllegalArgumentException("Format specifier '%" + conv + "' has no argument");
                arg = args[at];
                last = at;
            }
            String s;
            boolean numeric = true;
            switch (conv) {
                case 'd': s = integer(arg, fl); break;
                case 'x': case 'X': s = radix(arg, 16); if (conv == 'X') s = s.toUpperCase(); break;
                case 'o': s = radix(arg, 8); break;
                case 'f': s = fixed(arg, prec < 0 ? 6 : prec, fl); break;
                case 'e': case 'E': s = sci(arg, prec < 0 ? 6 : prec, fl); if (conv == 'E') s = s.toUpperCase(); break;
                case 'g': case 'G': s = general(arg, prec < 0 ? 6 : Math.max(prec, 1), fl); if (conv == 'G') s = s.toUpperCase(); break;
                default:
                    numeric = false;
                    switch (conv) {
                        case 's': case 'S': s = String.valueOf(arg); break;
                        case 'c': case 'C': s = arg instanceof Number ? String.valueOf((char) ((Number) arg).intValue()) : String.valueOf(arg); break;
                        case 'b': case 'B': s = arg == null ? "false" : arg instanceof Boolean ? arg.toString() : "true"; break;
                        case 'h': case 'H': s = arg == null ? "null" : Integer.toHexString(arg.hashCode()); break;
                        default: throw new IllegalArgumentException("Conversion = '" + conv + "'");
                    }
                    if (prec >= 0 && s.length() > prec) s = s.substring(0, prec);
                    if (Character.isUpperCase(conv)) s = s.toUpperCase();
            }
            out.append(pad(s, width, fl, numeric));
        }
        return out.toString();
    }

    private static String pad(String s, int width, String flags, boolean numeric) {
        if (width <= s.length()) return s;
        StringBuilder b = new StringBuilder();
        int fill = width - s.length();
        if (flags.indexOf('-') >= 0) {
            b.append(s);
            for (int i = 0; i < fill; i++) b.append(' ');
        } else if (numeric && flags.indexOf('0') >= 0) {
            int sign = (s.startsWith("-") || s.startsWith("+") || s.startsWith(" ")) ? 1 : 0;
            b.append(s, 0, sign);
            for (int i = 0; i < fill; i++) b.append('0');
            b.append(s, sign, s.length());
        } else {
            for (int i = 0; i < fill; i++) b.append(' ');
            b.append(s);
        }
        return b.toString();
    }

    private static String sign(String digits, boolean negative, String flags) {
        if (negative) return flags.indexOf('(') >= 0 ? "(" + digits + ")" : "-" + digits;
        if (flags.indexOf('+') >= 0) return "+" + digits;
        if (flags.indexOf(' ') >= 0) return " " + digits;
        return digits;
    }

    private static String group(String digits, String flags) {
        if (flags.indexOf(',') < 0 || digits.length() <= 3) return digits;
        StringBuilder b = new StringBuilder();
        int first = digits.length() % 3;
        if (first > 0) b.append(digits, 0, first);
        for (int i = first; i < digits.length(); i += 3) {
            if (b.length() > 0) b.append(',');
            b.append(digits, i, i + 3);
        }
        return b.toString();
    }

    private static String integer(Object arg, String flags) {
        if (arg == null) return "null";
        String v;
        if (arg instanceof BigInteger) v = arg.toString();
        else if (arg instanceof Long || arg instanceof Integer || arg instanceof Short || arg instanceof Byte) v = Long.toString(((Number) arg).longValue());
        else throw new IllegalArgumentException("d != " + arg.getClass().getName());
        boolean neg = v.startsWith("-");
        return sign(group(neg ? v.substring(1) : v, flags), neg, flags);
    }

    private static String radix(Object arg, int radix) {
        if (arg == null) return "null";
        if (arg instanceof Integer) return radix == 16 ? Integer.toHexString((Integer) arg) : Integer.toOctalString((Integer) arg);
        if (arg instanceof Long) return radix == 16 ? Long.toHexString((Long) arg) : Long.toOctalString((Long) arg);
        if (arg instanceof Short) return Integer.toString(((Short) arg) & 0xFFFF, radix);
        if (arg instanceof Byte) return Integer.toString(((Byte) arg) & 0xFF, radix);
        if (arg instanceof BigInteger) return ((BigInteger) arg).toString(radix);
        throw new IllegalArgumentException("x != " + arg.getClass().getName());
    }

    private static BigDecimal decimal(Object arg) {
        if (arg instanceof BigDecimal) return (BigDecimal) arg;
        if (arg instanceof Float) return new BigDecimal(Float.toString((Float) arg));
        if (arg instanceof Number) return new BigDecimal(Double.toString(((Number) arg).doubleValue()));
        throw new IllegalArgumentException("f != " + (arg == null ? "null" : arg.getClass().getName()));
    }

    private static String special(Object arg) {
        if (arg instanceof Double || arg instanceof Float) {
            double d = ((Number) arg).doubleValue();
            if (Double.isNaN(d)) return "NaN";
            if (Double.isInfinite(d)) return d > 0 ? "Infinity" : "-Infinity";
        }
        return null;
    }

    private static String fixed(Object arg, int prec, String flags) {
        if (arg == null) return "null";
        String sp = special(arg);
        if (sp != null) return sp;
        BigDecimal bd = decimal(arg).setScale(prec, RoundingMode.HALF_UP);
        boolean neg = bd.signum() < 0;
        String plain = bd.abs().toPlainString();
        int dot = plain.indexOf('.');
        String whole = dot < 0 ? plain : plain.substring(0, dot);
        String frac = dot < 0 ? "" : plain.substring(dot);
        return sign(group(whole, flags) + frac, neg, flags);
    }

    private static String sci(Object arg, int prec, String flags) {
        if (arg == null) return "null";
        String sp = special(arg);
        if (sp != null) return sp;
        BigDecimal bd = decimal(arg);
        boolean neg = bd.signum() < 0;
        bd = bd.abs();
        int exp = 0;
        if (bd.signum() != 0) {
            bd = bd.round(new MathContext(prec + 1, RoundingMode.HALF_UP));
            exp = bd.precision() - bd.scale() - 1;
            bd = bd.movePointLeft(exp);
        }
        String m = bd.setScale(prec, RoundingMode.HALF_UP).toPlainString();
        String e = Integer.toString(Math.abs(exp));
        if (e.length() < 2) e = "0" + e;
        return sign(m + "e" + (exp < 0 ? "-" : "+") + e, neg, flags);
    }

    private static String general(Object arg, int prec, String flags) {
        if (arg == null) return "null";
        String sp = special(arg);
        if (sp != null) return sp;
        BigDecimal bd = decimal(arg).abs();
        if (bd.signum() == 0) return fixed(arg, prec - 1, flags);
        BigDecimal r = bd.round(new MathContext(prec, RoundingMode.HALF_UP));
        if (r.compareTo(new BigDecimal("0.0001")) >= 0 && r.compareTo(BigDecimal.TEN.pow(prec)) < 0) {
            int exp = r.precision() - r.scale() - 1;
            return fixed(arg, Math.max(0, prec - 1 - exp), flags);
        }
        return sci(arg, prec - 1, flags);
    }
}
`,
  "LineReader.java": `package foct;

import java.io.BufferedReader;

/** new BufferedReader(new InputStreamReader(System.in)) for the browser runtime: reads one line at a time. */
public final class LineReader extends BufferedReader {
    public LineReader() {
        super(Stdin.reader(), 1);
    }

    @Override
    public String readLine() {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = Stdin.IN.readChar()) >= 0 && c != '\\n') sb.append((char) c);
        if (c < 0 && sb.length() == 0) return null;
        int n = sb.length();
        if (n > 0 && sb.charAt(n - 1) == '\\r') sb.setLength(n - 1);
        return sb.toString();
    }

    @Override
    public int read() {
        return Stdin.IN.readChar();
    }

    @Override
    public int read(char[] cbuf, int off, int len) {
        if (len == 0) return 0;
        int c = Stdin.IN.readChar();
        if (c < 0) return -1;
        cbuf[off] = (char) c;
        int n = 1;
        while (n < len && cbuf[off + n - 1] != '\\n' && Stdin.IN.availableChars() > 0) cbuf[off + n++] = (char) Stdin.IN.readChar();
        return n;
    }

    @Override
    public boolean ready() {
        return Stdin.IN.availableChars() > 0;
    }

    @Override
    public void close() {}
}
`,
  "ExitError.java": `package foct;

/** Thrown by System.exit() so the program can stop from anywhere. */
public final class ExitError extends Error {
    public final int status;

    public ExitError(int status) {
        super("System.exit(" + status + ")");
        this.status = status;
    }
}
`,
  "Sys.java": `package foct;

public final class Sys {
    private Sys() {}

    public static void exit(int status) {
        System.out.flush();
        throw new ExitError(status);
    }
}
`,
  "InputMismatchException.java": `package foct;

import java.util.NoSuchElementException;

public class InputMismatchException extends NoSuchElementException {
    public InputMismatchException() {
        super();
    }

    public InputMismatchException(String message) {
        super(message);
    }
}
`,
  "Scanner.java": `package foct;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** java.util.Scanner for FoCT Virtual Labs (the browser Java runtime has none). */
public final class Scanner implements Closeable, Iterator<String> {
    private final Reader reader;
    private final StringBuilder buf = new StringBuilder();
    private int pos;
    private int tokenEnd;
    private boolean eof;
    private boolean closed;
    private Pattern delimiter;

    public Scanner(InputStream source) {
        this(source == Stdin.IN ? Stdin.reader() : new Utf8Reader(source));
    }

    public Scanner(InputStream source, String charsetName) {
        this(source);
    }

    public Scanner(Reader source) {
        reader = source;
    }

    public Scanner(String source) {
        reader = null;
        buf.append(source);
        eof = true;
    }

    // ------------------------------------------------------------- buffer
    private boolean fill() {
        if (eof || reader == null) {
            eof = true;
            return false;
        }
        char[] cb = new char[1024];
        int n;
        try {
            n = reader.read(cb, 0, cb.length);
        } catch (IOException e) {
            n = -1;
        }
        if (n < 0) {
            eof = true;
            return false;
        }
        buf.append(cb, 0, n);
        return true;
    }

    private void compact() {
        if (pos > 8192) {
            buf.delete(0, pos);
            tokenEnd -= pos;
            pos = 0;
        }
    }

    private void ensureOpen() {
        if (closed) throw new IllegalStateException("Scanner closed");
    }

    /** Finds the next token without consuming it; null when there is none. */
    private String peek() {
        ensureOpen();
        if (delimiter != null) return peekDelimited();
        while (true) {
            while (pos < buf.length() && Character.isWhitespace(buf.charAt(pos))) pos++;
            if (pos < buf.length()) break;
            if (!fill()) return null;
        }
        int end = pos;
        while (true) {
            while (end < buf.length() && !Character.isWhitespace(buf.charAt(end))) end++;
            if (end < buf.length() || !fill()) break;
        }
        tokenEnd = end;
        return buf.substring(pos, end);
    }

    private String peekDelimited() {
        while (true) {
            int nl = buf.indexOf("\\n", pos);
            if (nl < 0 && fill()) continue;
            String rest = buf.substring(pos);
            Matcher m = delimiter.matcher(rest);
            int start = 0;
            while (m.find()) {
                if (m.start() == start && m.end() > start) {
                    start = m.end();
                    continue;
                }
                if (m.end() == m.start()) continue;
                pos += start;
                tokenEnd = pos + (m.start() - start);
                return buf.substring(pos, tokenEnd);
            }
            if (start >= rest.length()) {
                pos += start;
                if (!fill()) return null;
                continue;
            }
            if (!eof && fill()) continue;
            pos += start;
            tokenEnd = buf.length();
            return buf.substring(pos, tokenEnd);
        }
    }

    private void consume() {
        pos = tokenEnd;
        compact();
    }

    private InputMismatchException mismatch(String token) {
        return new InputMismatchException("For input string: \\"" + token + "\\"");
    }

    // ------------------------------------------------------------- tokens
    @Override
    public boolean hasNext() {
        return peek() != null;
    }

    @Override
    public String next() {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        consume();
        return t;
    }

    public int nextInt() {
        return nextInt(10);
    }

    public int nextInt(int radix) {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        try {
            int v = Integer.parseInt(strip(t), radix);
            consume();
            return v;
        } catch (NumberFormatException e) {
            throw mismatch(t);
        }
    }

    public long nextLong() {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        try {
            long v = Long.parseLong(strip(t));
            consume();
            return v;
        } catch (NumberFormatException e) {
            throw mismatch(t);
        }
    }

    public short nextShort() {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        try {
            short v = Short.parseShort(strip(t));
            consume();
            return v;
        } catch (NumberFormatException e) {
            throw mismatch(t);
        }
    }

    public byte nextByte() {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        try {
            byte v = Byte.parseByte(strip(t));
            consume();
            return v;
        } catch (NumberFormatException e) {
            throw mismatch(t);
        }
    }

    public double nextDouble() {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        try {
            double v = Double.parseDouble(strip(t));
            consume();
            return v;
        } catch (NumberFormatException e) {
            throw mismatch(t);
        }
    }

    public float nextFloat() {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        try {
            float v = Float.parseFloat(strip(t));
            consume();
            return v;
        } catch (NumberFormatException e) {
            throw mismatch(t);
        }
    }

    public boolean nextBoolean() {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        if (t.equalsIgnoreCase("true") || t.equalsIgnoreCase("false")) {
            consume();
            return t.equalsIgnoreCase("true");
        }
        throw mismatch(t);
    }

    public BigInteger nextBigInteger() {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        try {
            BigInteger v = new BigInteger(strip(t));
            consume();
            return v;
        } catch (NumberFormatException e) {
            throw mismatch(t);
        }
    }

    public BigDecimal nextBigDecimal() {
        String t = peek();
        if (t == null) throw new NoSuchElementException();
        try {
            BigDecimal v = new BigDecimal(strip(t));
            consume();
            return v;
        } catch (NumberFormatException e) {
            throw mismatch(t);
        }
    }

    private static String strip(String t) {
        return t.startsWith("+") ? t.substring(1) : t;
    }

    public boolean hasNextInt() {
        String t = peek();
        if (t == null) return false;
        try {
            Integer.parseInt(strip(t));
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public boolean hasNextLong() {
        String t = peek();
        if (t == null) return false;
        try {
            Long.parseLong(strip(t));
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public boolean hasNextDouble() {
        String t = peek();
        if (t == null) return false;
        try {
            Double.parseDouble(strip(t));
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public boolean hasNextBoolean() {
        String t = peek();
        return t != null && (t.equalsIgnoreCase("true") || t.equalsIgnoreCase("false"));
    }

    // ------------------------------------------------------------- lines
    public boolean hasNextLine() {
        ensureOpen();
        return pos < buf.length() || fill();
    }

    public String nextLine() {
        ensureOpen();
        while (true) {
            int nl = -1;
            for (int i = pos; i < buf.length(); i++) {
                char c = buf.charAt(i);
                if (c == '\\n' || c == '\\r') {
                    nl = i;
                    break;
                }
            }
            if (nl >= 0) {
                if (buf.charAt(nl) == '\\r' && nl + 1 >= buf.length() && fill()) continue;
                String line = buf.substring(pos, nl);
                int skip = (buf.charAt(nl) == '\\r' && nl + 1 < buf.length() && buf.charAt(nl + 1) == '\\n') ? 2 : 1;
                pos = nl + skip;
                tokenEnd = pos;
                compact();
                return line;
            }
            if (!fill()) {
                if (pos < buf.length()) {
                    String line = buf.substring(pos);
                    pos = buf.length();
                    tokenEnd = pos;
                    return line;
                }
                throw new NoSuchElementException("No line found");
            }
        }
    }

    // ------------------------------------------------------------- misc
    public Scanner useDelimiter(String pattern) {
        delimiter = Pattern.compile(pattern);
        return this;
    }

    public Scanner useDelimiter(Pattern pattern) {
        delimiter = pattern;
        return this;
    }

    public Pattern delimiter() {
        return delimiter != null ? delimiter : Pattern.compile("\\\\p{javaWhitespace}+");
    }

    public Scanner skip(String pattern) {
        return this;
    }

    @Override
    public void remove() {
        throw new UnsupportedOperationException();
    }

    @Override
    public void close() {
        closed = true;
    }

    @Override
    public String toString() {
        return "java.util.Scanner[FoCT Virtual Labs]";
    }
}
`,
};

// ------------------------------------------------------------------ lexer
/** Same-length copy of a Java source where comments, strings and chars are blanked out. */
export function maskJava(src) {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' && src.startsWith('"""', i)) {
      const e = src.indexOf('"""', i + 3);
      const end = e < 0 ? n : e + 3;
      blank(i + 1, end - 1);
      i = end;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(k, n));
      i = k + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

const SHIM_TYPES = ["Scanner", "InputMismatchException"];

/** Rewrites one student file. Returns { text, shift } where shift adjusts diagnostics columns. */
export function rewriteJava(src, opts = {}) {
  const masked = maskJava(src);
  const edits = [];
  const rules = opts.jdk ? [
    [/\bSystem\s*\.\s*exit\s*(?=\()/g, "foct.Sys.exit"],
  ] : [
    [/\bnew\s+(?:java\s*\.\s*io\s*\.\s*)?BufferedReader\s*\(\s*new\s+(?:java\s*\.\s*io\s*\.\s*)?InputStreamReader\s*\(\s*System\s*\.\s*in\s*(?:,[^()]*(?:\([^()]*\))?[^()]*)?\)\s*(?:,\s*\d+\s*)?\)/g, "new foct.LineReader()"],
    [/\bnew\s+(?:java\s*\.\s*io\s*\.\s*)?InputStreamReader\s*\(\s*System\s*\.\s*in\s*(?:,[^()]*(?:\([^()]*\))?[^()]*)?\)/g, "foct.Stdin.reader()"],
    [/\bSystem\s*\.\s*in\b/g, "foct.Stdin.IN"],
    [/\bSystem\s*\.\s*exit\s*(?=\()/g, "foct.Sys.exit"],
    [/\bSystem\s*\.\s*(out|err)\s*\.\s*(?:printf|format)\s*\(/g, (m, stream) => `foct.Fmt.printf(System.${stream}, `],
    [/\bString\s*\.\s*format\s*\(/g, "foct.Fmt.format("],
    [/\bjava\s*\.\s*util\s*\.\s*Scanner\b/g, "foct.Scanner"],
    [/\bjava\s*\.\s*util\s*\.\s*InputMismatchException\b/g, "foct.InputMismatchException"],
  ];
  for (const [re, rep] of rules) {
    for (const m of masked.matchAll(re)) {
      if (edits.some(([a, b]) => m.index < b && m.index + m[0].length > a)) continue;
      edits.push([m.index, m.index + m[0].length, typeof rep === "function" ? rep(...m) : rep]);
    }
  }
  edits.sort((a, b) => b[0] - a[0]);
  let text = src, code = masked;
  for (const [a, b, rep] of edits) {
    text = text.slice(0, a) + rep + text.slice(b);
    code = code.slice(0, a) + rep + code.slice(b);
  }
  // Add "import foct.X;" where the short name X is used.
  const imports = [];
  for (const t of opts.jdk ? [] : SHIM_TYPES) {
    const used = new RegExp(`(^|[^.\\w$])${t}\\b`).test(code);
    const declared = new RegExp(`\\b(class|interface|enum|record)\\s+${t}\\b`).test(code);
    const imported = new RegExp(`\\bimport\\s+[\\w.]+\\.${t}\\s*;`).test(code);
    if (used && !declared && !imported) imports.push(`import foct.${t};`);
  }
  let shift = null;
  if (imports.length) {
    const ins = " " + imports.join(" ") + " ";
    const pkg = /\bpackage\s+[\w.]+\s*;/.exec(code);
    const at = pkg ? pkg.index + pkg[0].length : 0;
    text = text.slice(0, at) + ins + text.slice(at);
    const line = text.slice(0, at).split("\n").length;
    const col = at - text.lastIndexOf("\n", at - 1);
    shift = { line, col, len: ins.length };
  }
  return { text, shift };
}

/** Finds classes that declare `public static void main(String[] ...)`. */
export function findMainClasses(src) {
  const code = maskJava(src);
  const pkg = (/\bpackage\s+([\w.]+)\s*;/.exec(code) || [])[1] || "";
  const result = [];
  const stack = [];
  let depth = 0;
  let pendingName = null;
  const re = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)|[{}]|\bstatic\b[^;{}()]*\bvoid\s+main\s*\(\s*(final\s+)?String/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[1]) {
      pendingName = m[2];
    } else if (m[0] === "{") {
      depth++;
      if (pendingName) {
        stack.push({ name: pendingName, depth });
        pendingName = null;
      }
    } else if (m[0] === "}") {
      if (stack.length && stack[stack.length - 1].depth === depth) stack.pop();
      depth--;
    } else if (stack.length) {
      const names = stack.map((s) => s.name).join("$");
      result.push((pkg ? pkg + "." : "") + names);
    }
  }
  return result;
}

export function packageOf(src) {
  return (/\bpackage\s+([\w.]+)\s*;/.exec(maskJava(src)) || [])[1] || "";
}

/** Control messages from the launcher travel on stderr between NUL characters. */
export const CONTROL = "\u0000FOCT:";

/**
 * The launcher receives the keyboard input typed so far as args[0] (args[1] = "1" after Ctrl+D).
 * If the program needs more, it reports NEED and the page re-runs it with the longer input.
 */
export function launcherSource(mainClass) {
  const ref = mainClass.replace(/\$/g, ".");
  return `public final class __FoctLauncher {
    public static void main(String[] args) {
        foct.Stdin.init(args.length > 0 ? args[0] : "", args.length > 1 && args[1].equals("1"));
        int status = 0;
        try {
            ${ref}.main(new String[0]);
        } catch (foct.NeedInput e) {
            System.out.flush();
            System.err.print("\\u0000FOCT:NEED\\u0000");
            System.err.flush();
            return;
        } catch (foct.ExitError e) {
            status = e.status;
        } catch (Throwable t) {
            System.out.flush();
            System.err.print("Exception in thread \\"main\\" ");
            t.printStackTrace();
            status = 1;
        }
        System.out.flush();
        System.err.flush();
        System.err.print("\\u0000FOCT:EXIT:" + status + "\\u0000");
        System.err.flush();
    }
}
`;
}
