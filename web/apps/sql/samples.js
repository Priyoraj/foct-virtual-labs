// Sample databases (portable SQL: works on SQLite and PostgreSQL) and example scripts.

export const DATASETS = {
  company: {
    title: "Company (EMP, DEPT, SALGRADE)",
    note: "The classic employee/department schema used in most DBMS lab manuals.",
    sql: `DROP TABLE IF EXISTS emp;
DROP TABLE IF EXISTS dept;
DROP TABLE IF EXISTS salgrade;

CREATE TABLE dept (
  deptno INTEGER PRIMARY KEY,
  dname  VARCHAR(20) NOT NULL,
  loc    VARCHAR(20)
);

CREATE TABLE emp (
  empno    INTEGER PRIMARY KEY,
  ename    VARCHAR(20) NOT NULL,
  job      VARCHAR(15),
  mgr      INTEGER REFERENCES emp(empno),
  hiredate DATE,
  sal      NUMERIC(9,2),
  comm     NUMERIC(9,2),
  deptno   INTEGER REFERENCES dept(deptno)
);

CREATE TABLE salgrade (
  grade INTEGER PRIMARY KEY,
  losal NUMERIC(9,2),
  hisal NUMERIC(9,2)
);

INSERT INTO dept VALUES
  (10, 'ACCOUNTING', 'GUWAHATI'), (20, 'RESEARCH', 'SHILLONG'),
  (30, 'SALES', 'KOLKATA'), (40, 'OPERATIONS', 'JORHAT');

INSERT INTO emp VALUES
  (7839, 'RAJESH',  'PRESIDENT', NULL, '2015-11-17', 150000, NULL, 10),
  (7698, 'BHASKAR', 'MANAGER',   7839, '2016-05-01',  85500, NULL, 30),
  (7782, 'CHITRA',  'MANAGER',   7839, '2016-06-09',  74500, NULL, 10),
  (7566, 'JAYANTA', 'MANAGER',   7839, '2016-04-02',  89250, NULL, 20),
  (7788, 'SNEHA',   'ANALYST',   7566, '2018-12-09',  90000, NULL, 20),
  (7902, 'FARHAN',  'ANALYST',   7566, '2017-12-03',  90000, NULL, 20),
  (7369, 'SANJAY',  'CLERK',     7902, '2019-12-17',  28000, NULL, 20),
  (7499, 'ANANYA',  'SALESMAN',  7698, '2017-02-20',  46000, 9000, 30),
  (7521, 'WASIM',   'SALESMAN',  7698, '2017-02-22',  37500, 15000, 30),
  (7654, 'MEERA',   'SALESMAN',  7698, '2017-09-28',  37500, 42000, 30),
  (7844, 'TANMOY',  'SALESMAN',  7698, '2017-09-08',  45000, 0, 30),
  (7876, 'ARJUN',   'CLERK',     7788, '2020-01-12',  33000, NULL, 20),
  (7900, 'JYOTI',   'CLERK',     7698, '2018-12-03',  28500, NULL, 30),
  (7934, 'MOHAN',   'CLERK',     7782, '2019-01-23',  39000, NULL, 10);

INSERT INTO salgrade VALUES
  (1, 20000, 30000), (2, 30001, 40000), (3, 40001, 60000), (4, 60001, 95000), (5, 95001, 999999);

SELECT * FROM emp;
`,
  },
  university: {
    title: "University (students, courses, enrollment)",
    note: "Departments, students, courses and marks.",
    sql: `DROP TABLE IF EXISTS enrollment;
DROP TABLE IF EXISTS course;
DROP TABLE IF EXISTS student;
DROP TABLE IF EXISTS department;

CREATE TABLE department (
  dept_id   VARCHAR(6) PRIMARY KEY,
  dept_name VARCHAR(40) NOT NULL,
  building  VARCHAR(20)
);

CREATE TABLE student (
  roll_no  INTEGER PRIMARY KEY,
  name     VARCHAR(40) NOT NULL,
  dept_id  VARCHAR(6) REFERENCES department(dept_id),
  semester INTEGER CHECK (semester BETWEEN 1 AND 8),
  city     VARCHAR(30),
  cgpa     NUMERIC(4,2)
);

CREATE TABLE course (
  course_id VARCHAR(10) PRIMARY KEY,
  title     VARCHAR(60) NOT NULL,
  dept_id   VARCHAR(6) REFERENCES department(dept_id),
  credits   INTEGER
);

CREATE TABLE enrollment (
  roll_no   INTEGER REFERENCES student(roll_no),
  course_id VARCHAR(10) REFERENCES course(course_id),
  marks     INTEGER CHECK (marks BETWEEN 0 AND 100),
  PRIMARY KEY (roll_no, course_id)
);

INSERT INTO department VALUES
  ('CSE', 'Computer Science and Engineering', 'Block A'),
  ('IT',  'Information Technology', 'Block A'),
  ('ECE', 'Electronics and Communication', 'Block B'),
  ('BCA', 'Computer Applications', 'Block C');

INSERT INTO student VALUES
  (101, 'Ananya Das',      'CSE', 5, 'Guwahati',  8.70),
  (102, 'Bikash Kalita',   'CSE', 5, 'Nalbari',   7.90),
  (103, 'Chandana Bora',   'IT',  3, 'Jorhat',    9.10),
  (104, 'Dipankar Saikia', 'ECE', 7, 'Tezpur',    6.80),
  (105, 'Esha Sharma',     'BCA', 1, 'Shillong',  8.20),
  (106, 'Farhan Ali',      'CSE', 3, 'Guwahati',  7.40),
  (107, 'Gargi Deka',      'IT',  5, 'Dibrugarh', 8.90),
  (108, 'Hiren Baruah',    'BCA', 3, 'Guwahati',  6.50);

INSERT INTO course VALUES
  ('CS301', 'Database Management Systems', 'CSE', 4),
  ('CS302', 'Operating Systems', 'CSE', 4),
  ('CS303', 'Computer Networks', 'CSE', 3),
  ('IT201', 'Web Technologies', 'IT', 3),
  ('EC401', 'Digital Signal Processing', 'ECE', 4),
  ('CA101', 'Programming in C', 'BCA', 4);

INSERT INTO enrollment VALUES
  (101, 'CS301', 88), (101, 'CS302', 79), (101, 'CS303', 91), (102, 'CS301', 72),
  (102, 'CS302', 65), (103, 'IT201', 94), (103, 'CS301', 85), (104, 'EC401', 58),
  (105, 'CA101', 81), (106, 'CS301', 67), (106, 'CS303', 74), (107, 'IT201', 89),
  (107, 'CS303', 83), (108, 'CA101', 55);

SELECT * FROM student;
`,
  },
  library: {
    title: "Library (books, members, issues)",
    note: "Books, members and who borrowed what.",
    sql: `DROP TABLE IF EXISTS issue;
DROP TABLE IF EXISTS member;
DROP TABLE IF EXISTS book;

CREATE TABLE book (
  book_id   INTEGER PRIMARY KEY,
  title     VARCHAR(80) NOT NULL,
  author    VARCHAR(60),
  publisher VARCHAR(40),
  year      INTEGER,
  copies    INTEGER DEFAULT 1
);

CREATE TABLE member (
  member_id INTEGER PRIMARY KEY,
  name      VARCHAR(40) NOT NULL,
  type      VARCHAR(10) CHECK (type IN ('student', 'faculty')),
  joined    DATE
);

CREATE TABLE issue (
  issue_id    INTEGER PRIMARY KEY,
  book_id     INTEGER REFERENCES book(book_id),
  member_id   INTEGER REFERENCES member(member_id),
  issue_date  DATE NOT NULL,
  return_date DATE
);

INSERT INTO book VALUES
  (1, 'Database System Concepts', 'Silberschatz, Korth, Sudarshan', 'McGraw Hill', 2019, 5),
  (2, 'Operating System Concepts', 'Silberschatz, Galvin, Gagne', 'Wiley', 2018, 4),
  (3, 'Computer Networks', 'Tanenbaum, Wetherall', 'Pearson', 2011, 3),
  (4, 'The C Programming Language', 'Kernighan, Ritchie', 'Prentice Hall', 1988, 6),
  (5, 'Introduction to Algorithms', 'Cormen et al.', 'MIT Press', 2022, 2),
  (6, 'Programming in ANSI C', 'E. Balagurusamy', 'McGraw Hill', 2019, 8),
  (7, 'Let Us C', 'Yashavant Kanetkar', 'BPB', 2020, 10);

INSERT INTO member VALUES
  (1, 'Ananya Das', 'student', '2024-07-20'), (2, 'Bikash Kalita', 'student', '2024-07-22'),
  (3, 'Dr. R. Choudhury', 'faculty', '2019-01-05'), (4, 'Gargi Deka', 'student', '2025-01-10'),
  (5, 'Prof. N. Hazarika', 'faculty', '2016-08-01');

INSERT INTO issue VALUES
  (1, 1, 1, '2026-09-01', '2026-09-14'), (2, 4, 2, '2026-09-03', NULL),
  (3, 5, 3, '2026-09-10', NULL), (4, 1, 4, '2026-09-15', '2026-10-01'),
  (5, 6, 1, '2026-10-02', NULL), (6, 3, 5, '2026-10-05', NULL);

SELECT * FROM book;
`,
  },
};

export const EXAMPLES = {
  "SELECT, WHERE, ORDER BY": { needs: "company", sql: `-- Load the Company sample first (menu > Sample databases).
SELECT ename, job, sal
FROM emp
WHERE sal > 40000 AND deptno IN (10, 20)
ORDER BY sal DESC;

SELECT DISTINCT job FROM emp ORDER BY job;

SELECT ename, sal, sal * 12 AS annual_salary FROM emp WHERE comm IS NULL;
` },
  "Joins": { needs: "company", sql: `-- Inner join: employees with their department
SELECT e.ename, e.job, d.dname, d.loc
FROM emp e JOIN dept d ON e.deptno = d.deptno
ORDER BY d.dname, e.ename;

-- Self join: employee and manager
SELECT e.ename AS employee, m.ename AS manager
FROM emp e LEFT JOIN emp m ON e.mgr = m.empno;

-- Non-equi join: salary grade
SELECT e.ename, e.sal, s.grade
FROM emp e JOIN salgrade s ON e.sal BETWEEN s.losal AND s.hisal;

-- Outer join: departments without employees
SELECT d.dname, COUNT(e.empno) AS staff
FROM dept d LEFT JOIN emp e ON e.deptno = d.deptno
GROUP BY d.dname;
` },
  "GROUP BY and HAVING": { needs: "company", sql: `SELECT deptno, COUNT(*) AS employees, SUM(sal) AS total, ROUND(AVG(sal), 2) AS average,
       MIN(sal) AS lowest, MAX(sal) AS highest
FROM emp
GROUP BY deptno
ORDER BY deptno;

SELECT job, COUNT(*) AS n
FROM emp
GROUP BY job
HAVING COUNT(*) > 1;
` },
  "Subqueries": { needs: "company", sql: `-- Earns more than the average
SELECT ename, sal FROM emp WHERE sal > (SELECT AVG(sal) FROM emp);

-- Highest paid employee in each department (correlated subquery)
SELECT e.deptno, e.ename, e.sal
FROM emp e
WHERE e.sal = (SELECT MAX(sal) FROM emp WHERE deptno = e.deptno)
ORDER BY e.deptno;

-- Second highest salary
SELECT MAX(sal) AS second_highest FROM emp WHERE sal < (SELECT MAX(sal) FROM emp);
` },
  "Views": { needs: "university", sql: `DROP VIEW IF EXISTS toppers;

CREATE VIEW toppers AS
SELECT s.roll_no, s.name, d.dept_name, s.cgpa
FROM student s JOIN department d ON s.dept_id = d.dept_id
WHERE s.cgpa >= 8.5;

SELECT * FROM toppers ORDER BY cgpa DESC;
` },
  "Aggregates on marks": { needs: "university", sql: `SELECT c.title, COUNT(*) AS students, ROUND(AVG(e.marks), 1) AS avg_marks, MAX(e.marks) AS best
FROM enrollment e JOIN course c ON c.course_id = e.course_id
GROUP BY c.title
ORDER BY avg_marks DESC;

SELECT s.name, SUM(c.credits) AS credits_taken
FROM student s JOIN enrollment e ON e.roll_no = s.roll_no JOIN course c ON c.course_id = e.course_id
GROUP BY s.name
ORDER BY credits_taken DESC;
` },
  "Transactions": { needs: "company", sql: `BEGIN;
UPDATE emp SET sal = sal * 1.10 WHERE deptno = 20;
SELECT ename, sal FROM emp WHERE deptno = 20;
ROLLBACK;  -- undo the raise

SELECT ename, sal FROM emp WHERE deptno = 20;
` },
  "Trigger (SQLite)": { needs: "library", engine: "sqlite", sql: `-- Keep the number of available copies up to date (SQLite trigger syntax)
DROP TRIGGER IF EXISTS on_issue;
CREATE TRIGGER on_issue AFTER INSERT ON issue
BEGIN
  UPDATE book SET copies = copies - 1 WHERE book_id = NEW.book_id;
END;

INSERT INTO issue VALUES (7, 7, 2, '2026-11-18', NULL);
SELECT book_id, title, copies FROM book WHERE book_id = 7;
` },
  "Trigger and function (PostgreSQL)": { needs: "library", engine: "postgres", sql: `-- PL/pgSQL: trigger function + trigger
CREATE OR REPLACE FUNCTION book_issued() RETURNS trigger AS $$
BEGIN
  IF (SELECT copies FROM book WHERE book_id = NEW.book_id) <= 0 THEN
    RAISE EXCEPTION 'No copies of book % left', NEW.book_id;
  END IF;
  UPDATE book SET copies = copies - 1 WHERE book_id = NEW.book_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_issue ON issue;
CREATE TRIGGER on_issue BEFORE INSERT ON issue
FOR EACH ROW EXECUTE FUNCTION book_issued();

INSERT INTO issue VALUES (7, 7, 2, '2026-11-18', NULL);
SELECT book_id, title, copies FROM book WHERE book_id = 7;
` },
  "Stored procedure (PostgreSQL)": { needs: "company", engine: "postgres", sql: `CREATE OR REPLACE PROCEDURE give_raise(p_dept INTEGER, p_percent NUMERIC)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE emp SET sal = ROUND(sal * (1 + p_percent / 100), 2) WHERE deptno = p_dept;
  RAISE NOTICE 'Raised salaries in department % by % percent', p_dept, p_percent;
END;
$$;

CALL give_raise(10, 5);
SELECT ename, sal FROM emp WHERE deptno = 10;

CREATE OR REPLACE FUNCTION annual_pay(p_empno INTEGER) RETURNS NUMERIC AS $$
  SELECT sal * 12 + COALESCE(comm, 0) FROM emp WHERE empno = p_empno;
$$ LANGUAGE sql;

SELECT ename, annual_pay(empno) FROM emp ORDER BY 2 DESC;
` },
};
