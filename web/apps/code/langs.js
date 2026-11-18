// Language definitions, starter templates and examples for the FoCT code IDE.
import { LEX_LANG } from "./lexyacc-examples.js";

const C_HELLO = `#include <stdio.h>

int main(void) {
    printf("Hello, World!\\n");
    return 0;
}
`;

const CPP_HELLO = `#include <iostream>
using namespace std;

int main() {
    cout << "Hello, World!" << endl;
    return 0;
}
`;

const JAVA_HELLO = `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
`;

const PY_HELLO = `print("Hello, World!")
`;

export const LANGS = {
  c: {
    id: "c", name: "C", title: "C Programming", monaco: "c", ext: ".c", main: "main.c",
    accept: ".c,.h,.txt,.csv,.dat,.in", runner: "clang", template: C_HELLO,
    newFile: (n) => n.endsWith(".h") ? `#ifndef ${guard(n)}\n#define ${guard(n)}\n\n\n\n#endif\n` : "",
    examples: {
      "Hello, World": C_HELLO,
      "Read two numbers (scanf)": `#include <stdio.h>

int main(void) {
    int a, b;
    printf("Enter two integers: ");
    scanf("%d %d", &a, &b);
    printf("Sum = %d\\n", a + b);
    printf("Product = %d\\n", a * b);
    if (b != 0)
        printf("Quotient = %.2f\\n", (double)a / b);
    return 0;
}
`,
      "Factorial and Fibonacci (recursion)": `#include <stdio.h>

long long factorial(int n) {
    return n <= 1 ? 1 : n * factorial(n - 1);
}

int fibonacci(int n) {
    return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}

int main(void) {
    int n;
    printf("Enter n: ");
    scanf("%d", &n);
    printf("%d! = %lld\\n", n, factorial(n));
    printf("First %d Fibonacci numbers:", n);
    for (int i = 0; i < n; i++)
        printf(" %d", fibonacci(i));
    printf("\\n");
    return 0;
}
`,
      "Bubble sort (arrays)": `#include <stdio.h>

void bubbleSort(int a[], int n) {
    for (int i = 0; i < n - 1; i++)
        for (int j = 0; j < n - 1 - i; j++)
            if (a[j] > a[j + 1]) {
                int t = a[j]; a[j] = a[j + 1]; a[j + 1] = t;
            }
}

int main(void) {
    int n, a[100];
    printf("How many numbers? ");
    scanf("%d", &n);
    printf("Enter %d numbers: ", n);
    for (int i = 0; i < n; i++) scanf("%d", &a[i]);
    bubbleSort(a, n);
    printf("Sorted:");
    for (int i = 0; i < n; i++) printf(" %d", a[i]);
    printf("\\n");
    return 0;
}
`,
      "Pointers: swap and arrays": `#include <stdio.h>

void swap(int *x, int *y) {
    int t = *x; *x = *y; *y = t;
}

int main(void) {
    int a = 10, b = 20;
    printf("Before swap: a = %d, b = %d\\n", a, b);
    swap(&a, &b);
    printf("After swap:  a = %d, b = %d\\n", a, b);

    int arr[] = {5, 10, 15, 20};
    int *p = arr;
    for (int i = 0; i < 4; i++)
        printf("*(p + %d) = %d at address %p\\n", i, *(p + i), (void *)(p + i));
    return 0;
}
`,
      "Structures: student records": `#include <stdio.h>
#include <string.h>

struct Student {
    int roll;
    char name[40];
    float marks;
};

int main(void) {
    struct Student s[3] = {
        {1, "Ananya", 88.5f}, {2, "Bikash", 92.0f}, {3, "Chandana", 79.5f}
    };
    int best = 0;
    printf("%-6s %-12s %s\\n", "Roll", "Name", "Marks");
    for (int i = 0; i < 3; i++) {
        printf("%-6d %-12s %.1f\\n", s[i].roll, s[i].name, s[i].marks);
        if (s[i].marks > s[best].marks) best = i;
    }
    printf("Topper: %s\\n", s[best].name);
    return 0;
}
`,
      "File handling (fopen / fprintf)": `#include <stdio.h>

int main(void) {
    FILE *fp = fopen("squares.txt", "w");
    if (!fp) { perror("fopen"); return 1; }
    for (int i = 1; i <= 10; i++)
        fprintf(fp, "%d %d\\n", i, i * i);
    fclose(fp);

    fp = fopen("squares.txt", "r");
    int n, sq, total = 0;
    while (fscanf(fp, "%d %d", &n, &sq) == 2)
        total += sq;
    fclose(fp);
    printf("Sum of squares 1..10 = %d\\n", total);
    printf("Open the Files tab to download squares.txt\\n");
    return 0;
}
`,
      "Matrix multiplication": `#include <stdio.h>

int main(void) {
    int a[2][3] = {{1, 2, 3}, {4, 5, 6}};
    int b[3][2] = {{7, 8}, {9, 10}, {11, 12}};
    int c[2][2] = {0};
    for (int i = 0; i < 2; i++)
        for (int j = 0; j < 2; j++)
            for (int k = 0; k < 3; k++)
                c[i][j] += a[i][k] * b[k][j];
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) printf("%5d", c[i][j]);
        printf("\\n");
    }
    return 0;
}
`,
    },
  },
  cpp: {
    id: "cpp", name: "C++", title: "C++ Programming", monaco: "cpp", ext: ".cpp", main: "main.cpp",
    accept: ".cpp,.cc,.cxx,.h,.hpp,.txt,.csv,.dat,.in", runner: "clang", template: CPP_HELLO,
    newFile: (n) => /\.(h|hpp)$/.test(n) ? `#pragma once\n\n` : "",
    examples: {
      "Hello, World": CPP_HELLO,
      "Classes and objects": `#include <iostream>
#include <string>
using namespace std;

class BankAccount {
    string owner;
    double balance;
public:
    BankAccount(string name, double initial) : owner(name), balance(initial) {}
    void deposit(double amount) { balance += amount; }
    bool withdraw(double amount) {
        if (amount > balance) return false;
        balance -= amount;
        return true;
    }
    void show() const { cout << owner << ": Rs. " << balance << endl; }
};

int main() {
    BankAccount acc("Priya", 1000);
    acc.deposit(500);
    if (!acc.withdraw(2000)) cout << "Insufficient balance!" << endl;
    acc.withdraw(300);
    acc.show();
    return 0;
}
`,
      "Inheritance and virtual functions": `#include <iostream>
#include <vector>
#include <memory>
using namespace std;

class Shape {
public:
    virtual double area() const = 0;
    virtual string name() const = 0;
    virtual ~Shape() = default;
};

class Circle : public Shape {
    double r;
public:
    explicit Circle(double r) : r(r) {}
    double area() const override { return 3.14159265 * r * r; }
    string name() const override { return "Circle"; }
};

class Rectangle : public Shape {
    double w, h;
public:
    Rectangle(double w, double h) : w(w), h(h) {}
    double area() const override { return w * h; }
    string name() const override { return "Rectangle"; }
};

int main() {
    vector<unique_ptr<Shape>> shapes;
    shapes.push_back(make_unique<Circle>(2.0));
    shapes.push_back(make_unique<Rectangle>(3.0, 4.5));
    for (const auto &s : shapes)
        cout << s->name() << " area = " << s->area() << '\\n';
    return 0;
}
`,
      "STL: vector, sort, map": `#include <iostream>
#include <vector>
#include <map>
#include <algorithm>
using namespace std;

int main() {
    vector<int> marks = {72, 95, 61, 88, 95, 40};
    sort(marks.begin(), marks.end(), greater<int>());
    cout << "Sorted (desc):";
    for (int m : marks) cout << ' ' << m;
    cout << "\\nHighest: " << marks.front() << ", Lowest: " << marks.back() << '\\n';

    map<string, int> wordCount;
    for (string w : {"lab", "code", "lab", "run", "code", "lab"}) wordCount[w]++;
    for (auto &[word, count] : wordCount)
        cout << word << " -> " << count << '\\n';
    return 0;
}
`,
      "Templates": `#include <iostream>
#include <string>
using namespace std;

template <typename T>
T maxOf(T a, T b) { return a > b ? a : b; }

template <typename T, int N>
class Stack {
    T items[N];
    int top = -1;
public:
    bool push(T x) { if (top == N - 1) return false; items[++top] = x; return true; }
    bool pop(T &x) { if (top < 0) return false; x = items[top--]; return true; }
};

int main() {
    cout << maxOf(3, 7) << ' ' << maxOf(2.5, 1.5) << ' ' << maxOf<string>("apple", "mango") << '\\n';
    Stack<int, 5> s;
    for (int i = 1; i <= 5; i++) s.push(i * 10);
    int x;
    while (s.pop(x)) cout << x << ' ';
    cout << '\\n';
}
`,
      "Operator overloading": `#include <iostream>
using namespace std;

class Complex {
    double re, im;
public:
    Complex(double r = 0, double i = 0) : re(r), im(i) {}
    Complex operator+(const Complex &o) const { return {re + o.re, im + o.im}; }
    Complex operator*(const Complex &o) const {
        return {re * o.re - im * o.im, re * o.im + im * o.re};
    }
    friend ostream &operator<<(ostream &os, const Complex &c) {
        return os << c.re << (c.im >= 0 ? " + " : " - ") << (c.im >= 0 ? c.im : -c.im) << "i";
    }
};

int main() {
    Complex a(2, 3), b(1, -4);
    cout << "a + b = " << a + b << endl;
    cout << "a * b = " << a * b << endl;
}
`,
      "Exception handling": `#include <iostream>
#include <stdexcept>
#include <vector>
using namespace std;

class InsufficientFunds : public runtime_error {
public:
    explicit InsufficientFunds(double need)
        : runtime_error("insufficient funds: need Rs. " + to_string((int)need) + " more") {}
};

class Account {
    double balance;
public:
    explicit Account(double b) : balance(b) {}
    void withdraw(double amount) {
        if (amount <= 0) throw invalid_argument("amount must be positive");
        if (amount > balance) throw InsufficientFunds(amount - balance);
        balance -= amount;
    }
    double getBalance() const { return balance; }
};

int main() {
    Account acc(5000);
    for (double amount : {1200.0, -50.0, 9000.0}) {
        try {
            acc.withdraw(amount);
            cout << "Withdrew " << amount << ", balance " << acc.getBalance() << endl;
        } catch (const InsufficientFunds &e) {
            cout << "Error: " << e.what() << endl;
        } catch (const exception &e) {
            cout << "Invalid request: " << e.what() << endl;
        }
    }
    try {
        vector<int> marks = {70, 80, 90};
        cout << marks.at(5) << endl;
    } catch (const out_of_range &e) {
        cout << "Caught out_of_range: index 5 does not exist" << endl;
    }
    return 0;
}
`,
      "Read input with cin": `#include <iostream>
#include <string>
using namespace std;

int main() {
    string name;
    int age;
    cout << "What is your name? ";
    getline(cin, name);
    cout << "How old are you? ";
    cin >> age;
    cout << "Hello " << name << ", in 5 years you will be " << age + 5 << "." << endl;
}
`,
      "File streams (ofstream / ifstream)": `#include <iostream>
#include <fstream>
#include <string>
using namespace std;

int main() {
    ofstream out("notes.txt");
    out << "Line one\\nLine two\\nLine three\\n";
    out.close();

    ifstream in("notes.txt");
    string line;
    int n = 0;
    while (getline(in, line)) cout << ++n << ": " << line << '\\n';
    cout << "Download notes.txt from the Files tab." << endl;
}
`,
    },
  },
  java: {
    id: "java", name: "Java", title: "Java Programming", monaco: "java", ext: ".java", main: "Main.java",
    accept: ".java,.txt,.csv", runner: "java", template: JAVA_HELLO,
    newFile: (n) => {
      const cls = n.replace(/\.java$/, "");
      return /^[A-Za-z_$][\w$]*$/.test(cls) ? `public class ${cls} {\n\n}\n` : "";
    },
    examples: {
      "Hello, World": JAVA_HELLO,
      "Scanner input": `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        System.out.print("How many numbers? ");
        int n = sc.nextInt();
        double sum = 0;
        for (int i = 1; i <= n; i++) {
            System.out.print("Number " + i + ": ");
            sum += sc.nextDouble();
        }
        System.out.printf("Sum = %.2f, Average = %.2f%n", sum, sum / n);
        sc.close();
    }
}
`,
      "Classes, inheritance, polymorphism": `abstract class Employee {
    protected final String name;
    Employee(String name) { this.name = name; }
    abstract double salary();
    @Override public String toString() {
        return String.format("%-10s %-10s %10.2f", getClass().getSimpleName(), name, salary());
    }
}

class Manager extends Employee {
    private final double base, bonus;
    Manager(String name, double base, double bonus) { super(name); this.base = base; this.bonus = bonus; }
    double salary() { return base + bonus; }
}

class Intern extends Employee {
    private final double stipend;
    Intern(String name, double stipend) { super(name); this.stipend = stipend; }
    double salary() { return stipend; }
}

public class Main {
    public static void main(String[] args) {
        Employee[] staff = { new Manager("Rahul", 60000, 15000), new Intern("Meera", 18000) };
        for (Employee e : staff) System.out.println(e);
    }
}
`,
      "Interfaces": `interface Shape {
    double area();
    default String describe() { return getClass().getSimpleName() + " with area " + String.format("%.2f", area()); }
}

class Circle implements Shape {
    private final double r;
    Circle(double r) { this.r = r; }
    public double area() { return Math.PI * r * r; }
}

class Square implements Shape {
    private final double side;
    Square(double side) { this.side = side; }
    public double area() { return side * side; }
}

public class Main {
    public static void main(String[] args) {
        Shape[] shapes = { new Circle(1.5), new Square(4) };
        for (Shape s : shapes) System.out.println(s.describe());
    }
}
`,
      "Collections: ArrayList and HashMap": `import java.util.*;

public class Main {
    public static void main(String[] args) {
        List<String> cities = new ArrayList<>(List.of("Guwahati", "Shillong", "Agartala", "Imphal"));
        Collections.sort(cities);
        System.out.println("Sorted cities: " + cities);

        Map<String, Integer> marks = new HashMap<>();
        marks.put("Ananya", 91);
        marks.put("Bikash", 78);
        marks.put("Chandana", 85);
        for (Map.Entry<String, Integer> e : marks.entrySet())
            System.out.println(e.getKey() + " scored " + e.getValue());
        System.out.println("Topper: " + Collections.max(marks.entrySet(), Map.Entry.comparingByValue()).getKey());
    }
}
`,
      "Exception handling": `class InsufficientFundsException extends Exception {
    InsufficientFundsException(String message) { super(message); }
}

public class Main {
    static double balance = 5000;

    static void withdraw(double amount) throws InsufficientFundsException {
        if (amount > balance) throw new InsufficientFundsException("Cannot withdraw " + amount + ", balance is " + balance);
        balance -= amount;
    }

    public static void main(String[] args) {
        try {
            withdraw(1200);
            System.out.println("Withdrawn. Balance = " + balance);
            withdraw(9000);
        } catch (InsufficientFundsException e) {
            System.out.println("Error: " + e.getMessage());
        } finally {
            System.out.println("Transaction finished.");
        }
        try {
            int[] a = new int[3];
            a[5] = 1;
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println("Caught: " + e);
        }
    }
}
`,
      "Streams and lambdas": `import java.util.*;
import java.util.stream.*;

public class Main {
    public static void main(String[] args) {
        List<Integer> nums = IntStream.rangeClosed(1, 20).boxed().collect(Collectors.toList());
        List<Integer> evenSquares = nums.stream().filter(n -> n % 2 == 0).map(n -> n * n).collect(Collectors.toList());
        System.out.println("Even squares: " + evenSquares);
        System.out.println("Sum = " + nums.stream().mapToInt(Integer::intValue).sum());
        String joined = Stream.of("java", "runs", "in", "the", "browser").map(String::toUpperCase).collect(Collectors.joining(" "));
        System.out.println(joined);
    }
}
`,
      "Recursion: Tower of Hanoi": `public class Main {
    static int moves = 0;

    static void hanoi(int n, char from, char to, char via) {
        if (n == 0) return;
        hanoi(n - 1, from, via, to);
        System.out.println("Move disk " + n + " from " + from + " to " + to);
        moves++;
        hanoi(n - 1, via, to, from);
    }

    public static void main(String[] args) {
        hanoi(3, 'A', 'C', 'B');
        System.out.println("Total moves: " + moves);
    }
}
`,
    },
  },
  python: {
    id: "python", name: "Python", title: "Python IDE", monaco: "python", ext: ".py", main: "main.py",
    accept: ".py,.txt,.csv,.json,.dat,.in,.tsv", runner: "python", template: PY_HELLO,
    newFile: () => "",
    examples: {
      "Hello, World": PY_HELLO,
      "Input and conditions": `name = input("Your name: ")
marks = float(input("Your marks (out of 100): "))

if marks >= 90:
    grade = "O"
elif marks >= 80:
    grade = "A+"
elif marks >= 70:
    grade = "A"
elif marks >= 60:
    grade = "B+"
elif marks >= 50:
    grade = "B"
else:
    grade = "F"

print(f"{name}, your grade is {grade}")
`,
      "Functions and recursion": `def factorial(n):
    return 1 if n <= 1 else n * factorial(n - 1)

def is_prime(n):
    if n < 2:
        return False
    return all(n % d for d in range(2, int(n ** 0.5) + 1))

n = int(input("Enter a number: "))
print(f"{n}! = {factorial(n)}")
print("Primes up to", n, ":", [p for p in range(n + 1) if is_prime(p)])
`,
      "Lists, dictionaries, comprehensions": `marks = {"Ananya": 91, "Bikash": 78, "Chandana": 85, "Dipankar": 66}

topper = max(marks, key=marks.get)
average = sum(marks.values()) / len(marks)
passed = [name for name, m in marks.items() if m >= 70]

print("Topper:", topper)
print(f"Class average: {average:.1f}")
print("Scored 70+:", ", ".join(sorted(passed)))

squares = {x: x * x for x in range(1, 6)}
print(squares)
`,
      "Classes and objects": `class Student:
    college = "Assam down town University"

    def __init__(self, name, roll):
        self.name = name
        self.roll = roll
        self.marks = []

    def add_mark(self, m):
        self.marks.append(m)

    def average(self):
        return sum(self.marks) / len(self.marks) if self.marks else 0

    def __str__(self):
        return f"{self.roll}: {self.name} ({self.college}) avg={self.average():.1f}"

s = Student("Riya", 101)
for m in (78, 85, 92):
    s.add_mark(m)
print(s)
`,
      "File handling": `with open("data.txt", "w") as f:
    for i in range(1, 6):
        f.write(f"{i},{i * i}\\n")

with open("data.txt") as f:
    rows = [line.strip().split(",") for line in f]

total = sum(int(sq) for _, sq in rows)
print("Rows:", rows)
print("Sum of squares:", total)
print("Download data.txt from the Files tab.")
`,
      "NumPy basics": `import numpy as np

a = np.arange(1, 10).reshape(3, 3)
print("Matrix A:\\n", a)
print("Transpose:\\n", a.T)
print("A @ A.T:\\n", a @ a.T)
print("Mean of each column:", a.mean(axis=0))
b = np.array([[2, 1], [1, 3]])
print("Determinant of B:", round(np.linalg.det(b), 2))
print("Inverse of B:\\n", np.linalg.inv(b))
`,
      "pandas DataFrame": `import pandas as pd

df = pd.DataFrame({
    "name": ["Ananya", "Bikash", "Chandana", "Dipankar", "Esha"],
    "dept": ["CSE", "IT", "CSE", "IT", "CSE"],
    "marks": [91, 78, 85, 66, 88],
})
print(df)
print()
print(df.groupby("dept")["marks"].agg(["mean", "max", "count"]))
print()
print("Above 80:")
print(df[df["marks"] > 80].sort_values("marks", ascending=False).to_string(index=False))
df.to_csv("marks.csv", index=False)
`,
      "Matplotlib plot": `import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 2 * np.pi, 200)
plt.figure(figsize=(7, 4))
plt.plot(x, np.sin(x), label="sin(x)")
plt.plot(x, np.cos(x), label="cos(x)", linestyle="--")
plt.title("Trigonometric functions")
plt.xlabel("x (radians)")
plt.grid(alpha=0.3)
plt.legend()
plt.show()
`,
      "Machine learning (scikit-learn)": `from sklearn.datasets import load_iris
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier
from sklearn.metrics import accuracy_score, classification_report

X, y = load_iris(return_X_y=True)
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.3, random_state=42)

model = DecisionTreeClassifier(max_depth=3, random_state=42)
model.fit(X_train, y_train)
pred = model.predict(X_test)

print("Accuracy:", round(accuracy_score(y_test, pred), 3))
print(classification_report(y_test, pred, target_names=load_iris().target_names))
`,
    },
  },
};

function guard(n) {
  return n.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function langFromFile(name) {
  const n = name.toLowerCase();
  if (n.endsWith(".py")) return "python";
  if (n.endsWith(".java")) return "java";
  if (/\.(cpp|cc|cxx|hpp|hh)$/.test(n)) return "cpp";
  if (/\.(c|h)$/.test(n)) return "c";
  return null;
}

export function monacoLanguageFor(name, fallback) {
  const n = name.toLowerCase();
  if (/\.(l|lex)$/.test(n)) return "lex";
  if (/\.(y|yacc)$/.test(n)) return "yacc";
  if (n.endsWith(".py")) return "python";
  if (n.endsWith(".java")) return "java";
  if (/\.(cpp|cc|cxx|hpp|hh)$/.test(n)) return "cpp";
  if (/\.(c|h)$/.test(n)) return fallback === "cpp" ? "cpp" : "c";
  if (n.endsWith(".json")) return "json";
  if (n.endsWith(".md")) return "markdown";
  if (n.endsWith(".html") || n.endsWith(".htm")) return "html";
  return "plaintext";
}

LANGS.lex = LEX_LANG;
