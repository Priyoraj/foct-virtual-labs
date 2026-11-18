import javax.tools.*;
import java.io.*;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * FoCT Virtual Labs: compile-and-run service inside the in-browser OpenJDK (JavaBox).
 *
 * Started once through JavaBox's CompileServer; afterwards it owns stdin. Protocol (UTF-8):
 *   page -> JVM : "FOCT_RUN <mainClass> <files>\n" then per file "FOCT_FILE <name> <bytes>\n" + bytes
 *                 keyboard lines while a program runs; a line holding only \u0004 means end of input
 *   JVM -> page : lines starting with \u0001 are control messages, everything else is program output
 */
public class FoctServer {
    static final InputStream RAW_IN = System.in;
    static final PrintStream RAW_OUT = System.out;
    static final PrintStream RAW_ERR = System.err;
    static final JavaCompiler JAVAC = ToolProvider.getSystemJavaCompiler();
    static final String C = "\u0001";

    public static void main(String[] args) throws Exception {
        RAW_OUT.println(C + "FOCT_READY " + System.getProperty("java.version"));
        RAW_OUT.flush();
        String line;
        while ((line = readLine()) != null) {
            if (line.startsWith("FOCT_RUN ")) {
                try {
                    run(line);
                } catch (Throwable t) {
                    restoreStreams();
                    RAW_OUT.println(C + "FOCT_ERROR " + t);
                    RAW_OUT.println(C + "FOCT_EXIT 1");
                }
                RAW_OUT.flush();
            } else if (line.equals("FOCT_PING")) {
                RAW_OUT.println(C + "FOCT_READY " + System.getProperty("java.version"));
                RAW_OUT.flush();
            }
        }
    }

    /** Reads one protocol line byte by byte, so nothing meant for the program is swallowed. */
    static String readLine() throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = RAW_IN.read()) != -1 && c != '\n') b.write(c);
        if (c == -1 && b.size() == 0) return null;
        return b.toString(StandardCharsets.UTF_8);
    }

    static byte[] readBytes(int n) throws IOException {
        byte[] out = new byte[n];
        int off = 0;
        while (off < n) {
            int r = RAW_IN.read(out, off, n - off);
            if (r < 0) throw new EOFException();
            off += r;
        }
        return out;
    }

    // ------------------------------------------------------------------ in-memory javac
    static final class Source extends SimpleJavaFileObject {
        final String code;
        Source(String name, String code) {
            super(URI.create("string:///" + name), Kind.SOURCE);
            this.code = code;
        }
        @Override public CharSequence getCharContent(boolean ignore) { return code; }
    }

    static final class ClassOut extends SimpleJavaFileObject {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ClassOut(String name) { super(URI.create("mem:///" + name.replace('.', '/') + ".class"), Kind.CLASS); }
        @Override public OutputStream openOutputStream() { return bytes; }
    }

    static final class Files extends ForwardingJavaFileManager<StandardJavaFileManager> {
        final Map<String, ClassOut> out = new HashMap<>();
        Files(StandardJavaFileManager m) { super(m); }
        @Override
        public JavaFileObject getJavaFileForOutput(Location loc, String name, JavaFileObject.Kind kind, FileObject sib) {
            ClassOut c = new ClassOut(name);
            out.put(name, c);
            return c;
        }
    }

    static final class Loader extends ClassLoader {
        final Map<String, ClassOut> classes;
        Loader(Map<String, ClassOut> classes) { super(FoctServer.class.getClassLoader()); this.classes = classes; }
        @Override protected Class<?> findClass(String name) throws ClassNotFoundException {
            ClassOut c = classes.get(name);
            if (c == null) throw new ClassNotFoundException(name);
            byte[] b = c.bytes.toByteArray();
            return defineClass(name, b, 0, b.length);
        }
    }

    // ------------------------------------------------------------------ program I/O
    /** Program output: whole lines go straight out; a pending partial line is sent on flush. */
    static final class LineOut extends OutputStream {
        final boolean err;
        final ByteArrayOutputStream line = new ByteArrayOutputStream();
        LineOut(boolean err) { this.err = err; }
        @Override public synchronized void write(int b) {
            if (b == '\n') {
                (err ? RAW_ERR : RAW_OUT).println(line.toString(StandardCharsets.UTF_8));
                line.reset();
            } else {
                line.write(b);
            }
        }
        @Override public synchronized void flush() {
            if (line.size() > 0) {
                RAW_OUT.println(C + (err ? "FOCT_PARTERR " : "FOCT_PART ") + line.toString(StandardCharsets.UTF_8));
                line.reset();
            }
            RAW_OUT.flush();
            RAW_ERR.flush();
        }
    }

    static PrintStream progOut, progErr;

    /** Keyboard input for the program; asks the page for a line when empty. */
    static final class ProgramIn extends InputStream {
        byte[] buf = new byte[0];
        int pos;
        boolean eof;
        boolean fill() throws IOException {
            if (eof) return false;
            progOut.flush();
            progErr.flush();
            RAW_OUT.println(C + "FOCT_WAIT");
            RAW_OUT.flush();
            String line = readLine();
            if (line == null || line.equals("\u0004")) {
                eof = true;
                return false;
            }
            buf = (line + "\n").getBytes(StandardCharsets.UTF_8);
            pos = 0;
            return true;
        }
        @Override public int read() throws IOException {
            if (pos >= buf.length && !fill()) return -1;
            return buf[pos++] & 0xFF;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            if (pos >= buf.length && !fill()) return -1;
            int n = Math.min(len, buf.length - pos);
            System.arraycopy(buf, pos, b, off, n);
            pos += n;
            return n;
        }
        @Override public int available() { return buf.length - pos; }
    }

    static void restoreStreams() {
        System.setIn(RAW_IN);
        System.setOut(RAW_OUT);
        System.setErr(RAW_ERR);
    }

    // ------------------------------------------------------------------ one run
    static void run(String header) throws Exception {
        String[] h = header.split(" ");
        String mainClass = h[1];
        int count = Integer.parseInt(h[2]);
        List<JavaFileObject> sources = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String[] f = readLine().split(" ");
            String name = f[1];
            String code = new String(readBytes(Integer.parseInt(f[2])), StandardCharsets.UTF_8);
            readLine(); // newline after the file bytes
            sources.add(new Source(name, code));
        }
        long t0 = System.currentTimeMillis();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        Files files = new Files(JAVAC.getStandardFileManager(diags, Locale.US, StandardCharsets.UTF_8));
        boolean ok = JAVAC.getTask(null, files, diags, List.of("-g", "-encoding", "UTF-8", "-Xlint:-options"), null, sources).call();
        for (Diagnostic<? extends JavaFileObject> d : diags.getDiagnostics()) {
            String file = d.getSource() == null ? "" : d.getSource().toUri().getPath().replaceFirst("^/", "");
            RAW_OUT.println(C + "FOCT_DIAG " + d.getKind() + "\t" + file + "\t" + d.getLineNumber() + "\t"
                    + d.getColumnNumber() + "\t" + d.getMessage(Locale.US).replace("\\", "\\\\").replace("\n", "\\n"));
        }
        if (!ok) {
            RAW_OUT.println(C + "FOCT_EXIT compile");
            return;
        }
        RAW_OUT.println(C + "FOCT_COMPILED " + (System.currentTimeMillis() - t0));
        RAW_OUT.flush();

        progOut = new PrintStream(new LineOut(false), true, StandardCharsets.UTF_8);
        progErr = new PrintStream(new LineOut(true), true, StandardCharsets.UTF_8);
        System.setIn(new ProgramIn());
        System.setOut(progOut);
        System.setErr(progErr);
        int status = 0;
        try {
            Class<?> cls = new Loader(files.out).loadClass(mainClass);
            Method m = cls.getMethod("main", String[].class);
            m.setAccessible(true);
            m.invoke(null, (Object) new String[0]);
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            Integer exit = exitStatus(cause);
            if (exit != null) {
                status = exit;
            } else {
                progOut.flush();
                trimTrace(cause);
                progErr.print("Exception in thread \"main\" ");
                cause.printStackTrace(progErr);
                status = 1;
            }
        } catch (NoSuchMethodException e) {
            progErr.println("error: no  public static void main(String[] args)  in class " + mainClass);
            status = 1;
        }
        progOut.flush();
        progErr.flush();
        restoreStreams();
        RAW_OUT.println(C + "FOCT_EXIT " + status);
        RAW_OUT.flush();
    }

    /** Hide the reflection/launcher frames below the student's main(). */
    static void trimTrace(Throwable t) {
        Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        for (; t != null && seen.add(t); t = t.getCause()) {
            StackTraceElement[] st = t.getStackTrace();
            int cut = st.length;
            for (int i = 0; i < st.length; i++) {
                String c = st[i].getClassName();
                if (c.startsWith("jdk.internal.reflect.") || c.startsWith("java.lang.reflect.")
                        || c.equals("FoctServer") || c.equals("CompileServer")) {
                    cut = i;
                    break;
                }
            }
            t.setStackTrace(Arrays.copyOf(st, cut));
        }
    }

    /** System.exit(n) in student code is rewritten to throw foct.ExitError (see the IDE). */
    static Integer exitStatus(Throwable t) {
        for (; t != null; t = t.getCause()) {
            if (t.getClass().getName().equals("foct.ExitError")) {
                try {
                    return t.getClass().getField("status").getInt(t);
                } catch (ReflectiveOperationException e) {
                    return 0;
                }
            }
        }
        return null;
    }
}
