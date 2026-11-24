"""List the operators of one ONNX model, without the onnx package.

The graph is walked at the wire level: a ModelProto has graph in field 7, a
GraphProto has node in field 1, and a NodeProto has op_type in field 4 and
domain in field 7. That is enough to write the reduced operator config that
onnxruntime's --include_ops_by_config reads, which is the whole point of this
script: the build recipe must not depend on a Python stack.
"""
import collections
import sys

MODEL = sys.argv[1] if len(sys.argv) > 1 else "/data/workspace/gosfu/static/fastenhancer-s.onnx"
OUT = sys.argv[2] if len(sys.argv) > 2 else "required_operators.config"


def varint(buf, i):
    shift = 0
    val = 0
    while True:
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not b & 0x80:
            return val, i
        shift += 7


def fields(buf):
    """Yield (field number, wire type, payload) for one message."""
    i = 0
    n = len(buf)
    while i < n:
        key, i = varint(buf, i)
        num, wire = key >> 3, key & 7
        if wire == 0:
            val, i = varint(buf, i)
            yield num, wire, val
        elif wire == 2:
            ln, i = varint(buf, i)
            yield num, wire, buf[i:i + ln]
            i += ln
        elif wire == 1:
            yield num, wire, buf[i:i + 8]
            i += 8
        elif wire == 5:
            yield num, wire, buf[i:i + 4]
            i += 4
        else:
            raise ValueError("wire type " + str(wire))


def main():
    data = open(MODEL, "rb").read()
    ir = 0
    graph = None
    for num, wire, val in fields(data):
        if num == 1 and wire == 0:
            ir = val
        elif num == 7 and wire == 2:
            graph = val
    if graph is None:
        raise SystemExit("no graph in " + MODEL)
    counts = collections.Counter()
    for num, wire, val in fields(graph):
        if num != 1 or wire != 2:
            continue
        op = ""
        dom = ""
        for n2, w2, v2 in fields(val):
            if n2 == 4 and w2 == 2:
                op = v2.decode()
            elif n2 == 7 and w2 == 2:
                dom = v2.decode()
        counts[(dom or "ai.onnx", op)] += 1
    ops = sorted({op for (_, op) in counts})
    line = "ai.onnx;%d;%s" % (ir if ir else 13, ",".join(ops))
    with open(OUT, "w") as fh:
        fh.write(line + "\n")
    print("model      ", MODEL)
    print("ir version ", ir)
    print("operators  ", len(ops))
    for (dom, op), c in sorted(counts.items()):
        print("  %-22s %3d" % (op, c))
    print("config     ", line[:300] + (" ..." if len(line) > 300 else ""))


main()
