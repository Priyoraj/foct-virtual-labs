"""Read, inspect and repair the TeaVM javac class library (compile-classlib-teavm.bin).

The archive is gzip( repeat [u16 name length][name][u32 data length][class file bytes] ).

The published library still contains TeaVM's internal method names (getMessage0, getClass0,
wait0 ...) carrying @org.teavm.interop.Rename("getMessage") etc., so javac cannot see
Throwable.getMessage(), Object.getClass(), Object.wait()/notify() and friends.
`fix_archive` applies @Rename and @Remove the same way TeaVM does when it builds its library.

    python tools/javasdk.py web/runtimes/teavm/compile-classlib-teavm.bin
"""
import gzip
import struct
import sys


def read_archive(path):
    raw = gzip.decompress(open(path, "rb").read())
    pos, entries = 0, []
    while pos < len(raw):
        (n,) = struct.unpack(">H", raw[pos:pos + 2]); pos += 2
        name = raw[pos:pos + n].decode(); pos += n
        (ln,) = struct.unpack(">I", raw[pos:pos + 4]); pos += 4
        entries.append([name, raw[pos:pos + ln]]); pos += ln
    return entries


def write_archive(path, entries):
    out = bytearray()
    for name, data in entries:
        nb = name.encode()
        out += struct.pack(">H", len(nb)) + nb + struct.pack(">I", len(data)) + data
    with open(path, "wb") as f:
        f.write(gzip.compress(bytes(out), compresslevel=9, mtime=0))


class ClassFile:
    def __init__(self, data):
        d = self.data = data
        (count,) = struct.unpack(">H", d[8:10])
        pos, i = 10, 1
        self.cp = [None]
        self.cp_raw = []          # raw bytes of each entry, in order
        while i < count:
            tag = d[pos]
            start = pos
            if tag == 1:
                (ln,) = struct.unpack(">H", d[pos + 1:pos + 3])
                self.cp.append((1, d[pos + 3:pos + 3 + ln].decode("utf-8", "replace")))
                pos += 3 + ln
            elif tag in (3, 4):
                self.cp.append((tag, d[pos + 1:pos + 5])); pos += 5
            elif tag in (5, 6):
                self.cp.append((tag, d[pos + 1:pos + 9])); pos += 9
            elif tag in (7, 8, 16, 19, 20):
                self.cp.append((tag, d[pos + 1:pos + 3])); pos += 3
            elif tag in (9, 10, 11, 12, 17, 18):
                self.cp.append((tag, d[pos + 1:pos + 5])); pos += 5
            elif tag == 15:
                self.cp.append((tag, d[pos + 1:pos + 4])); pos += 4
            else:
                raise ValueError(f"bad constant pool tag {tag}")
            self.cp_raw.append(d[start:pos])
            if tag in (5, 6):
                self.cp.append(None)
                i += 1
            i += 1
        self.cp_count = count
        self.cp_end = pos
        self.access, self.this_idx, self.super_idx = struct.unpack(">HHH", d[pos:pos + 6])
        pos += 6
        (ni,) = struct.unpack(">H", d[pos:pos + 2])
        pos += 2 + 2 * ni
        self.fields_start = pos
        (nf,) = struct.unpack(">H", d[pos:pos + 2]); pos += 2
        for _ in range(nf):
            pos = self._member_end(pos)
        self.methods_start = pos
        (nm,) = struct.unpack(">H", d[pos:pos + 2]); pos += 2
        self.methods = []        # [access, name_idx, desc_idx, [(attr_name, bytes)]]
        for _ in range(nm):
            acc, n_i, d_i, na = struct.unpack(">HHHH", d[pos:pos + 8])
            p = pos + 8
            attrs = []
            for _ in range(na):
                an, ln = struct.unpack(">HI", d[p:p + 6])
                attrs.append((an, d[p + 6:p + 6 + ln]))
                p += 6 + ln
            self.methods.append([acc, n_i, d_i, attrs])
            pos = p
        self.methods_end = pos

    def _member_end(self, pos):
        d = self.data
        (na,) = struct.unpack(">H", d[pos + 6:pos + 8])
        pos += 8
        for _ in range(na):
            (ln,) = struct.unpack(">I", d[pos + 2:pos + 6])
            pos += 6 + ln
        return pos

    def utf(self, idx):
        e = self.cp[idx]
        return e[1] if e and e[0] == 1 else None

    @property
    def name(self):
        (ni,) = struct.unpack(">H", self.cp[self.this_idx][1])
        return self.utf(ni)

    def method_list(self):
        return [(m[0], self.utf(m[1]), self.utf(m[2])) for m in self.methods]

    # -------------------------------------------------------- annotations
    def annotations(self, attrs):
        """{annotation type descriptor: {element name: value}} for visible+invisible annotations."""
        found = {}
        for an, body in attrs:
            if self.utf(an) not in ("RuntimeVisibleAnnotations", "RuntimeInvisibleAnnotations"):
                continue
            (num,) = struct.unpack(">H", body[:2])
            pos = 2
            for _ in range(num):
                t, pos, values = self._annotation(body, pos)
                found[t] = values
        return found

    def _annotation(self, b, pos):
        ti, npairs = struct.unpack(">HH", b[pos:pos + 4])
        pos += 4
        values = {}
        for _ in range(npairs):
            (ni,) = struct.unpack(">H", b[pos:pos + 2])
            v, pos = self._element(b, pos + 2)
            values[self.utf(ni)] = v
        return self.utf(ti), pos, values

    def _element(self, b, pos):
        tag = chr(b[pos]); pos += 1
        if tag in "BCDFIJSZs":
            (ci,) = struct.unpack(">H", b[pos:pos + 2])
            return (self.utf(ci) if tag == "s" else ci), pos + 2
        if tag == "e":
            return None, pos + 4
        if tag == "c":
            return None, pos + 2
        if tag == "@":
            _, pos, v = self._annotation(b, pos)
            return v, pos
        if tag == "[":
            (n,) = struct.unpack(">H", b[pos:pos + 2]); pos += 2
            out = []
            for _ in range(n):
                v, pos = self._element(b, pos)
                out.append(v)
            return out, pos
        raise ValueError("bad element tag " + tag)

    # -------------------------------------------------------- rewriting
    def fixed(self):
        """Apply TeaVM @Rename / @Remove to methods. Returns new bytes (or None if unchanged)."""
        new_utf = []
        index = {}
        count = self.cp_count

        def utf_index(s):
            nonlocal count
            for i, e in enumerate(self.cp):
                if e and e[0] == 1 and e[1] == s:
                    return i
            if s not in index:
                b = s.encode("utf-8")
                new_utf.append(struct.pack(">BH", 1, len(b)) + b)
                index[s] = count
                count += 1
            return index[s]

        changed = False
        keep = []
        removed = {id(m) for m in self.methods if "Lorg/teavm/interop/Remove;" in self.annotations(m[3])}
        existing = {(self.utf(m[1]), self.utf(m[2])) for m in self.methods if id(m) not in removed}
        for m in self.methods:
            ann = self.annotations(m[3])
            if id(m) in removed:
                changed = True
                continue
            ren = ann.get("Lorg/teavm/interop/Rename;")
            # Constructor juggling (<init> <-> fakeInit) is internal to TeaVM; javac needs the originals.
            if ren and ren.get("value") and "<init>" not in (self.utf(m[1]), ren["value"]):
                target = (ren["value"], self.utf(m[2]))
                if target in existing:
                    changed = True      # the real method is already declared
                    continue
                m = [m[0], utf_index(ren["value"]), m[2], m[3]]
                existing.add(target)
                changed = True
            keep.append(m)
        if not changed:
            return None
        d = self.data
        out = bytearray(d[:8]) + struct.pack(">H", count)
        out += d[10:self.cp_end] + b"".join(new_utf)
        out += d[self.cp_end:self.methods_start]
        out += struct.pack(">H", len(keep))
        for acc, n_i, d_i, attrs in keep:
            out += struct.pack(">HHHH", acc, n_i, d_i, len(attrs))
            for an, body in attrs:
                out += struct.pack(">HI", an, len(body)) + body
        out += d[self.methods_end:]
        return bytes(out)


def fix_archive(src, dst=None):
    entries = read_archive(src)
    n = 0
    for e in entries:
        if not e[0].endswith(".class"):
            continue
        new = ClassFile(e[1]).fixed()
        if new is not None:
            e[1] = new
            n += 1
    write_archive(dst or src, entries)
    return n


if __name__ == "__main__":
    path = sys.argv[1]
    print("fixed", fix_archive(path), "classes in", path)
