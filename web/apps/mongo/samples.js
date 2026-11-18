/* FoCT Virtual Labs - MongoDB Lab: sample databases and example scripts.
   Loaded as a classic script by both the page and the engine worker (self.FOCT_MONGO).
   Names, people and orders are invented for teaching. */
(function () {
  "use strict";

  // Deterministic ObjectIds, so the sample data is the same on every PC.
  const oidMaker = (ObjectId, tag) => (i) =>
    new ObjectId((0x66900000 + i * 977).toString(16).padStart(8, "0") + tag + (i + 1).toString(16).padStart(8, "0"));
  const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

  // ------------------------------------------------------------------ college
  function college(ObjectId) {
    const id = oidMaker(ObjectId, "c011e9e0");
    const pin = { Guwahati: 781001, Jorhat: 785001, Dibrugarh: 786001, Nalbari: 781335, Sivasagar: 785640,
      Tezpur: 784001, Silchar: 788001, Shillong: 793001, Nagaon: 782001 };
    const people = [
      ["Ananya Das", "F", "CSE", 3, 9.1, "Guwahati", "Assam", true, ["C", "Python", "SQL", "Java"]],
      ["Rahul Sharma", "M", "CSE", 3, 7.8, "Jorhat", "Assam", true, ["C", "Java"]],
      ["Priyanka Baruah", "F", "ECE", 2, 8.6, "Dibrugarh", "Assam", false, ["C", "MATLAB", "Python"]],
      ["Bikash Kalita", "M", "ME", 4, 6.9, "Nalbari", "Assam", true, ["AutoCAD", "C"]],
      ["Nilakshi Gogoi", "F", "CSE", 4, 9.4, "Sivasagar", "Assam", false, ["Python", "SQL", "JavaScript", "C"]],
      ["Arindam Bora", "M", "CE", 1, 7.2, "Tezpur", "Assam", true, ["AutoCAD"]],
      ["Sneha Deka", "F", "ECE", 3, 8.1, "Guwahati", "Assam", false, ["C", "Verilog", "Python"]],
      ["Rohan Saikia", "M", "CSE", 2, 6.4, "Jorhat", "Assam", true, ["C", "Python"]],
      ["Pooja Nath", "F", "ME", 2, 7.6, "Silchar", "Assam", true, ["AutoCAD", "Python"]],
      ["Kunal Choudhury", "M", "CSE", 1, 8.8, "Shillong", "Meghalaya", false, ["C", "Java", "Python", "SQL"]],
      ["Riya Hazarika", "F", "CE", 3, 8.3, "Guwahati", "Assam", false, ["AutoCAD", "C"]],
      ["Manash Phukan", "M", "ECE", 4, 7.0, "Dibrugarh", "Assam", true, ["C", "Verilog"]],
      ["Debashree Medhi", "F", "CSE", 3, 8.9, "Nagaon", "Assam", true, ["Java", "SQL", "Python"]],
      ["Ankur Talukdar", "M", "ME", 3, 6.7, "Guwahati", "Assam", false, ["C"]],
      ["Jyotishmita Sarma", "F", "ECE", 1, 9.0, "Tezpur", "Assam", true, ["C", "Python", "MATLAB"]],
      ["Dhruba Rajkhowa", "M", "CSE", 4, 7.5, "Shillong", "Meghalaya", true, ["C", "Java", "JavaScript"]],
    ];
    const students = people.map(([name, gender, dept, year, cgpa, city, state, hostel, skills], i) => {
      const [first, last] = name.toLowerCase().split(" ");
      const doc = {
        _id: id(i), rollno: 2101 + i, name, gender, dept, year, cgpa,
        marks: { dbms: 58 + (i * 17) % 41, os: 55 + (i * 23) % 44, cn: 57 + (i * 31) % 42 },
        skills, address: { city, state, pin: pin[city] }, hostel,
        email: `${first}.${last}@student.example`,
        joined: day(2027 - year, 8, 1),
      };
      if (i % 3 !== 0) doc.phone = "98" + String(54012345 + i * 1111).slice(0, 8);
      return doc;
    });
    const courses = [
      { _id: "CS301", title: "Database Management Systems", dept: "CSE", semester: 5, credits: 4, faculty: "Dr. Mitali Barman" },
      { _id: "CS302", title: "Operating Systems", dept: "CSE", semester: 5, credits: 4, faculty: "Mr. Hemanta Kalita" },
      { _id: "CS303", title: "Computer Networks", dept: "CSE", semester: 5, credits: 3, faculty: "Dr. Nabajit Das" },
      { _id: "CS401", title: "Compiler Design", dept: "CSE", semester: 7, credits: 4, faculty: "Dr. Rupam Baruah" },
      { _id: "EC301", title: "Digital Signal Processing", dept: "ECE", semester: 5, credits: 4, faculty: "Dr. Gitanjali Saikia" },
      { _id: "EC302", title: "VLSI Design", dept: "ECE", semester: 6, credits: 3, faculty: "Mr. Pranjal Deka" },
      { _id: "ME301", title: "Thermodynamics", dept: "ME", semester: 3, credits: 4, faculty: "Dr. Ajit Bora" },
      { _id: "CE301", title: "Structural Analysis", dept: "CE", semester: 5, credits: 4, faculty: "Dr. Ritu Sharma" },
    ];
    const departments = [
      { _id: "CSE", name: "Computer Science and Engineering", hod: "Dr. Mitali Barman", block: "A", intake: 120 },
      { _id: "ECE", name: "Electronics and Communication Engineering", hod: "Dr. Gitanjali Saikia", block: "B", intake: 60 },
      { _id: "ME", name: "Mechanical Engineering", hod: "Dr. Ajit Bora", block: "C", intake: 60 },
      { _id: "CE", name: "Civil Engineering", hod: "Dr. Ritu Sharma", block: "C", intake: 60 },
    ];
    const grade = (m) => (m >= 90 ? "O" : m >= 80 ? "A+" : m >= 70 ? "A" : m >= 60 ? "B+" : m >= 50 ? "B" : "C");
    const enrolments = [];
    students.forEach((s, i) => {
      const mine = courses.filter((c) => c.dept === s.dept);
      mine.slice(0, 2).forEach((c, j) => {
        const marks = 48 + ((i + 3) * (j + 7) * 13) % 52;
        enrolments.push({ rollno: s.rollno, course: c._id, semester: c.semester, marks, grade: grade(marks) });
      });
    });
    return { students, courses, departments, enrolments };
  }

  // ------------------------------------------------------------------ shop
  function shop(ObjectId) {
    const cid = oidMaker(ObjectId, "5b0c0570");
    const oid = oidMaker(ObjectId, "0bde5000");
    const customers = [
      ["Arjun Mehta", "Guwahati", "gold", day(2023, 4, 12)],
      ["Farida Begum", "Jorhat", "silver", day(2024, 1, 3)],
      ["Gaurav Singh", "Tezpur", "basic", day(2025, 6, 21)],
      ["Hiyamoni Bora", "Dibrugarh", "gold", day(2022, 11, 30)],
      ["Imran Hussain", "Guwahati", "basic", day(2026, 2, 14)],
      ["Jahnavi Kakoty", "Nagaon", "silver", day(2024, 9, 9)],
      ["Kabir Dutta", "Silchar", "basic", day(2025, 12, 1)],
      ["Lina Rabha", "Goalpara", "basic", day(2026, 8, 18)],
    ].map(([name, city, membership, joined], i) => ({
      _id: cid(i), name, email: name.toLowerCase().replace(" ", ".") + "@mail.example", city, membership, joined,
    }));
    const products = [
      ["P101", "Wireless Mouse", "Electronics", 599, 40, ["computer", "wireless"], 4.3],
      ["P102", "USB-C Charger 65W", "Electronics", 899, 25, ["charger", "laptop"], 4.1],
      ["P103", "Bluetooth Speaker", "Electronics", 1999, 12, ["audio", "wireless"], 4.5],
      ["P104", "Data Structures Using C", "Books", 450, 30, ["programming", "textbook"], 4.6],
      ["P105", "Learning MongoDB", "Books", 650, 18, ["database", "nosql"], 4.4],
      ["P106", "Compiler Design Made Easy", "Books", 520, 10, ["compilers", "textbook"], 3.9],
      ["P107", "Gel Pen Pack (10)", "Stationery", 120, 200, ["pens"], 4.0],
      ["P108", "Spiral Notebook A4", "Stationery", 80, 350, ["notebook", "paper"], 4.2],
      ["P109", "Scientific Calculator", "Electronics", 1150, 22, ["exam", "maths"], 4.7],
      ["P110", "Assam Silk Stole", "Clothing", 1450, 8, ["silk", "handloom"], 4.8],
      ["P111", "Cotton T-shirt", "Clothing", 399, 60, ["cotton", "casual"], 3.8],
      ["P112", "Laptop Backpack", "Accessories", 1299, 15, ["bag", "laptop"], 4.4],
    ].map(([_id, name, category, price, stock, tags, rating]) => ({ _id, name, category, price, stock, tags, rating }));
    const price = Object.fromEntries(products.map((p) => [p._id, p.price]));
    const spec = [
      [0, 6, 2, "delivered", "UPI", [["P101", 1], ["P108", 4]]],
      [1, 6, 5, "delivered", "card", [["P104", 2]]],
      [0, 6, 18, "delivered", "UPI", [["P103", 1]]],
      [3, 6, 25, "delivered", "COD", [["P110", 2], ["P107", 3]]],
      [2, 7, 1, "cancelled", "UPI", [["P109", 1]]],
      [4, 7, 8, "delivered", "UPI", [["P111", 3], ["P108", 2]]],
      [5, 7, 13, "delivered", "card", [["P105", 1], ["P106", 1]]],
      [3, 7, 22, "delivered", "UPI", [["P112", 1]]],
      [6, 8, 2, "delivered", "COD", [["P107", 5], ["P108", 5]]],
      [1, 8, 9, "shipped", "UPI", [["P102", 1], ["P101", 1]]],
      [0, 8, 15, "delivered", "card", [["P109", 1], ["P104", 1]]],
      [2, 8, 27, "delivered", "UPI", [["P111", 2]]],
      [5, 9, 3, "delivered", "UPI", [["P103", 1], ["P107", 2]]],
      [4, 9, 11, "cancelled", "COD", [["P112", 1]]],
      [3, 9, 19, "delivered", "card", [["P105", 2]]],
      [6, 9, 28, "shipped", "UPI", [["P110", 1]]],
      [1, 10, 4, "pending", "COD", [["P106", 1], ["P108", 3]]],
      [0, 10, 12, "pending", "UPI", [["P102", 1]]],
      [5, 10, 20, "shipped", "card", [["P101", 2], ["P111", 1]]],
      [2, 10, 29, "pending", "UPI", [["P104", 1], ["P107", 1]]],
    ];
    const orders = spec.map(([c, m, d, status, payment, lines], i) => {
      const items = lines.map(([product_id, qty]) => ({ product_id, qty, price: price[product_id] }));
      return {
        _id: oid(i), customer_id: customers[c]._id, order_date: day(2026, m, d), status, payment,
        items, total: items.reduce((s, it) => s + it.qty * it.price, 0), city: customers[c].city,
      };
    });
    return { customers, products, orders };
  }

  // ------------------------------------------------------------------ library
  function library(ObjectId) {
    const bid = oidMaker(ObjectId, "b00c5000");
    const lid = oidMaker(ObjectId, "10a05000");
    const books = [
      ["9780078022159", "Database System Concepts", ["Abraham Silberschatz", "Henry F. Korth", "S. Sudarshan"], 2019, ["Databases", "Computer Science"], "McGraw Hill", 1376, 4,
        "Relational databases, SQL, transactions, indexing and query processing for undergraduate courses."],
      ["9781491954461", "MongoDB: The Definitive Guide", ["Shannon Bradshaw", "Eoin Brazil", "Kristina Chodorow"], 2019, ["Databases", "NoSQL"], "O'Reilly", 514, 2,
        "Document database design, queries, indexes, aggregation, replication and sharding with MongoDB."],
      ["9781119800361", "Operating System Concepts", ["Abraham Silberschatz", "Peter B. Galvin", "Greg Gagne"], 2018, ["Operating Systems"], "Wiley", 1040, 5,
        "Processes, threads, scheduling, memory management and file systems of a modern operating system."],
      ["9780321486813", "Compilers: Principles, Techniques, and Tools", ["Alfred V. Aho", "Monica S. Lam", "Ravi Sethi", "Jeffrey D. Ullman"], 2006, ["Compilers", "Computer Science"], "Pearson", 1009, 3,
        "Lexical analysis, parsing, syntax-directed translation, intermediate code and code optimization."],
      ["9780132126953", "Computer Networks", ["Andrew S. Tanenbaum", "David J. Wetherall"], 2010, ["Networks"], "Pearson", 960, 4,
        "Network layers from the physical link to applications, with routing, congestion control and security."],
      ["9780131103627", "The C Programming Language", ["Brian W. Kernighan", "Dennis M. Ritchie"], 1988, ["Programming"], "Prentice Hall", 272, 6,
        "A compact tour of the C language: types, pointers, structures and the standard library."],
      ["9781593279288", "Python Crash Course", ["Eric Matthes"], 2019, ["Programming", "Python"], "No Starch Press", 544, 3,
        "Learn Python by building projects: a game, data visualizations and a small web application."],
      ["9780262033848", "Introduction to Algorithms", ["Thomas H. Cormen", "Charles E. Leiserson", "Ronald L. Rivest", "Clifford Stein"], 2009, ["Algorithms", "Computer Science"], "MIT Press", 1312, 4,
        "Sorting, graph algorithms, dynamic programming and data structures with proofs of correctness."],
      ["9781098104030", "Python for Data Analysis", ["Wes McKinney"], 2022, ["Data Science", "Python"], "O'Reilly", 579, 2,
        "Cleaning, reshaping and analysing data with pandas and NumPy in Python."],
      ["9781491960202", "Learning Web Design", ["Jennifer Niederst Robbins"], 2018, ["Web"], "O'Reilly", 808, 2,
        "HTML, CSS, JavaScript and web graphics for building modern web pages."],
      ["9780134610993", "Artificial Intelligence: A Modern Approach", ["Stuart Russell", "Peter Norvig"], 2020, ["Artificial Intelligence", "Computer Science"], "Pearson", 1136, 3,
        "Search, knowledge representation, planning, machine learning and intelligent agents."],
      ["9780134549897", "Digital Design", ["M. Morris Mano", "Michael D. Ciletti"], 2017, ["Electronics"], "Pearson", 720, 3,
        "Boolean algebra, combinational and sequential logic, and hardware description languages."],
      ["9780596009205", "Head First Java", ["Kathy Sierra", "Bert Bates"], 2005, ["Programming", "Java"], "O'Reilly", 688, 2,
        "Object-oriented programming in Java explained with puzzles, pictures and exercises."],
      ["9780133591620", "Modern Operating Systems", ["Andrew S. Tanenbaum", "Herbert Bos"], 2014, ["Operating Systems"], "Pearson", 1136, 2,
        "Operating system design with case studies of Linux, Windows and Android."],
    ].map(([isbn, title, authors, year, genres, publisher, pages, total, summary], i) => ({
      _id: bid(i), isbn, title, authors, year, genres, publisher, pages,
      copies: { total, available: total - (i % 3 === 0 ? 1 : 0) - (i % 5 === 0 ? 1 : 0) }, summary,
      ratings: [4 + (i % 2), 3 + (i % 3), 5 - (i % 4 === 0 ? 1 : 0)],
    }));
    const members = [
      ["M001", "Ananya Das", "student", "CSE"], ["M002", "Rahul Sharma", "student", "CSE"],
      ["M003", "Sneha Deka", "student", "ECE"], ["M004", "Dr. Mitali Barman", "faculty", "CSE"],
      ["M005", "Riya Hazarika", "student", "CE"], ["M006", "Dr. Ajit Bora", "faculty", "ME"],
    ].map(([_id, name, type, dept]) => ({ _id, name, type, dept }));
    const loanSpec = [
      [0, "M001", 9, 1, true], [3, "M004", 9, 3, true], [1, "M002", 9, 10, false], [6, "M001", 9, 15, true],
      [2, "M003", 9, 22, false], [7, "M005", 10, 1, true], [3, "M002", 10, 6, false], [8, "M004", 10, 9, true],
      [5, "M006", 10, 14, false], [0, "M005", 10, 20, false], [10, "M003", 10, 27, false], [12, "M001", 11, 2, false],
    ];
    const loans = loanSpec.map(([b, member_id, m, d, back], i) => {
      const issued = day(2026, m, d);
      const due = new Date(issued.getTime() + 14 * 864e5);
      return { _id: lid(i), book_id: books[b]._id, member_id, issued, due, returned: back ? new Date(issued.getTime() + (6 + i) * 864e5) : null };
    });
    return { books, members, loans };
  }

  const DATASETS = {
    college: { title: "College", desc: "students, courses, departments, enrolments", build: college },
    shop: { title: "Online shop", desc: "customers, products, orders", build: shop },
    library: { title: "Library", desc: "books, members, loans", build: library },
  };

  // ------------------------------------------------------------------ example scripts
  const EXAMPLES = [
    {
      title: "CRUD basics: insert, find, update, delete", needs: null, code: `// CRUD basics. Ctrl+Enter runs everything; select some lines to run only those.
use labdemo
db.friends.drop()

// Create
db.friends.insertOne({ name: "Asha", age: 21, city: "Guwahati", hobbies: ["music", "chess"] })
db.friends.insertMany([
  { name: "Bikash", age: 23, city: "Jorhat", hobbies: ["football"] },
  { name: "Chitra", age: 20, city: "Guwahati", hobbies: ["painting", "music"] },
  { name: "Dhruv", age: 22, city: "Tezpur" }
])

// Read
db.friends.find()
db.friends.find({ city: "Guwahati" }, { _id: 0, name: 1, age: 1 })
db.friends.findOne({ age: { $gt: 21 } })
db.friends.countDocuments()

// Update
db.friends.updateOne({ name: "Dhruv" }, { $set: { hobbies: ["cricket"] } })
db.friends.updateMany({}, { $inc: { age: 1 } })
db.friends.find({}, { _id: 0, name: 1, age: 1 }).sort({ age: -1 })

// Delete
db.friends.deleteOne({ name: "Bikash" })
db.friends.countDocuments()
`,
    },
    {
      title: "Query operators", needs: "college", code: `// Query operators on the college sample database
use college

// comparison: $gt $gte $lt $lte $ne $in $nin
db.students.find({ cgpa: { $gte: 8.5 } }, { _id: 0, name: 1, cgpa: 1 })
db.students.find({ dept: { $in: ["ECE", "ME"] } }, { _id: 0, name: 1, dept: 1 })

// logical: $and (implicit) $or $not $nor
db.students.find({ dept: "CSE", hostel: true }, { _id: 0, name: 1 })
db.students.find({ $or: [{ year: 4 }, { cgpa: { $lt: 7 } }] }, { _id: 0, name: 1, year: 1, cgpa: 1 })

// embedded documents: dot notation
db.students.find({ "address.city": "Jorhat" }, { _id: 0, name: 1, address: 1 })
db.students.find({ "marks.dbms": { $gt: 85 } }, { _id: 0, name: 1, "marks.dbms": 1 })

// arrays: a value, $all, $size
db.students.find({ skills: "Java" }, { _id: 0, name: 1, skills: 1 })
db.students.find({ skills: { $all: ["C", "Python"] } }, { _id: 0, name: 1 })
db.students.find({ skills: { $size: 4 } }, { _id: 0, name: 1, skills: 1 })

// regular expressions and missing fields
db.students.find({ name: /^R/ }, { _id: 0, name: 1 })
db.students.countDocuments({ phone: { $exists: false } })

// sort, skip, limit: the top three by CGPA
db.students.find({}, { _id: 0, name: 1, cgpa: 1 }).sort({ cgpa: -1 }).limit(3)
`,
    },
    {
      title: "Update operators and upsert", needs: "college", code: `// Update operators
use college

db.students.updateOne({ rollno: 2101 }, { $set: { "address.pin": 781026 }, $push: { skills: "MongoDB" } })
db.students.findOne({ rollno: 2101 }, { _id: 0, name: 1, skills: 1, address: 1 })

db.students.updateMany({ dept: "ME" }, { $set: { lab: "Workshop" } })
db.students.updateOne({ rollno: 2102 }, { $addToSet: { skills: "C" } })     // C is already there: not added again
db.students.updateOne({ rollno: 2102 }, { $pull: { skills: "Java" } })
db.students.updateOne({ rollno: 2103 }, { $unset: { phone: "" } })
db.students.updateOne({ rollno: 2104 }, { $rename: { hostel: "inHostel" } })
db.students.updateOne({ rollno: 2105 }, { $inc: { year: -1 }, $currentDate: { updatedAt: true } })

// the positional operator $ changes the array element that matched
db.students.updateOne({ rollno: 2101, skills: "C" }, { $set: { "skills.$": "C17" } })

// upsert: update if found, otherwise insert
db.students.updateOne({ rollno: 2199 }, { $set: { name: "New Student", dept: "CSE", year: 1 } }, { upsert: true })
db.students.replaceOne({ rollno: 2199 }, { rollno: 2199, name: "Replaced Student", dept: "ECE", year: 1 })

db.students.find({ rollno: { $in: [2101, 2102, 2103, 2104, 2199] } }, { _id: 0, marks: 0, joined: 0, email: 0 })
`,
    },
    {
      title: "Indexes and explain()", needs: "college", code: `// Indexes: compare a collection scan with an index scan
use college
db.students.dropIndexes()        // start again without extra indexes
db.students.getIndexes()

// No index on rollno yet: MongoDB examines every document (COLLSCAN)
db.students.find({ rollno: 2105 }).explain("executionStats")

db.students.createIndex({ rollno: 1 }, { unique: true })

// Now it looks up one index key (IXSCAN) and examines one document
db.students.find({ rollno: 2105 }).explain("executionStats")

// A unique index rejects duplicates
db.students.insertOne({ rollno: 2105, name: "Duplicate Roll Number" })

// A compound index serves queries on dept (and dept + cgpa)
db.students.createIndex({ dept: 1, cgpa: -1 })
db.students.find({ dept: "CSE", cgpa: { $gt: 8 } }).explain().queryPlanner.winningPlan
db.students.getIndexes()
db.students.dropIndex("dept_1_cgpa_-1")
`,
    },
    {
      title: "Aggregation: group and summarise", needs: "college", code: `// The aggregation pipeline
use college

// students and average CGPA in each department
db.students.aggregate([
  { $group: { _id: "$dept", students: { $sum: 1 }, avgCgpa: { $avg: "$cgpa" } } },
  { $sort: { avgCgpa: -1 } }
])

// the topper of each department
db.students.aggregate([
  { $sort: { cgpa: -1 } },
  { $group: { _id: "$dept", topper: { $first: "$name" }, cgpa: { $first: "$cgpa" } } },
  { $sort: { _id: 1 } }
])

// total marks with $project, then filter and sort
db.students.aggregate([
  { $project: { _id: 0, name: 1, total: { $add: ["$marks.dbms", "$marks.os", "$marks.cn"] } } },
  { $match: { total: { $gte: 230 } } },
  { $sort: { total: -1 } }
])

// how many students know each skill: $unwind makes one document per array element
db.students.aggregate([
  { $unwind: "$skills" },
  { $group: { _id: "$skills", count: { $sum: 1 } } },
  { $sort: { count: -1, _id: 1 } }
])

// CGPA bands with $bucket
db.students.aggregate([
  { $bucket: { groupBy: "$cgpa", boundaries: [0, 7, 8, 9, 10], default: "other",
               output: { count: { $sum: 1 }, names: { $push: "$name" } } } }
])
`,
    },
    {
      title: "Joins with $lookup and $unwind", needs: "shop", code: `// Joining collections in the online shop
use shop

// each order with its customer's name
db.orders.aggregate([
  { $lookup: { from: "customers", localField: "customer_id", foreignField: "_id", as: "customer" } },
  { $unwind: "$customer" },
  { $project: { _id: 0, order_date: 1, status: 1, total: 1, customer: "$customer.name" } },
  { $limit: 5 }
])

// revenue per category: one document per order line, joined with products
db.orders.aggregate([
  { $match: { status: { $ne: "cancelled" } } },
  { $unwind: "$items" },
  { $lookup: { from: "products", localField: "items.product_id", foreignField: "_id", as: "product" } },
  { $unwind: "$product" },
  { $group: { _id: "$product.category",
              revenue: { $sum: { $multiply: ["$items.qty", "$items.price"] } },
              units: { $sum: "$items.qty" } } },
  { $sort: { revenue: -1 } }
])

// customers who have never ordered
db.customers.aggregate([
  { $lookup: { from: "orders", localField: "_id", foreignField: "customer_id", as: "orders" } },
  { $match: { orders: { $size: 0 } } },
  { $project: { _id: 0, name: 1, city: 1 } }
])

// sales per month
db.orders.aggregate([
  { $match: { status: { $ne: "cancelled" } } },
  { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$order_date" } }, orders: { $sum: 1 }, sales: { $sum: "$total" } } },
  { $sort: { _id: 1 } }
])
`,
    },
    {
      title: "Map-Reduce", needs: "shop", code: `// Total amount spent by each customer, the classic map-reduce way
use shop

var mapFn = function () { emit(this.customer_id, this.total); };
var reduceFn = function (key, values) { return Array.sum(values); };

db.orders.mapReduce(mapFn, reduceFn, { query: { status: "delivered" }, out: "customer_totals" })
db.customer_totals.find().sort({ value: -1 })

// orders per payment method, results returned inline
db.orders.mapReduce(
  function () { emit(this.payment, 1); },
  function (key, values) { return Array.sum(values); },
  { out: { inline: 1 } }
)

// the same total with the aggregation pipeline (the recommended way today)
db.orders.aggregate([
  { $match: { status: "delivered" } },
  { $group: { _id: "$customer_id", value: { $sum: "$total" } } },
  { $sort: { value: -1 } }
])
`,
    },
    {
      title: "Text search", needs: "library", code: `// Full-text search needs a text index
use library
db.books.createIndex({ title: "text", summary: "text" })

db.books.find({ $text: { $search: "database" } }, { _id: 0, title: 1 })

// several words match any of them; -word excludes; sort by relevance
db.books.find(
  { $text: { $search: "python data -web" } },
  { _id: 0, title: 1, score: { $meta: "textScore" } }
).sort({ score: { $meta: "textScore" } })

// an exact phrase
db.books.find({ $text: { $search: "\\"operating system\\"" } }, { _id: 0, title: 1 })

// regex search without an index
db.books.find({ title: { $regex: "comp", $options: "i" } }, { _id: 0, title: 1, year: 1 })
`,
    },
    {
      title: "Schema validation", needs: null, code: `// A collection that only accepts valid documents
use labdemo
db.employees.drop()

db.createCollection("employees", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["name", "email", "salary"],
      properties: {
        name: { bsonType: "string", description: "must be a string" },
        email: { bsonType: "string", pattern: "^.+@.+$" },
        salary: { bsonType: "number", minimum: 10000 },
        dept: { enum: ["CSE", "ECE", "ME", "CE"] }
      }
    }
  }
})

db.employees.insertOne({ name: "Mridul", email: "mridul@example.com", salary: 45000, dept: "CSE" })
db.employees.insertOne({ name: "Tina", email: "tina-at-example", salary: 5000 })       // rejected
db.employees.insertOne({ name: "Barun", email: "barun@example.com", salary: 30000, dept: "IT" })  // rejected
db.employees.find()
`,
    },
    {
      title: "Cursors and JavaScript", needs: null, code: `// The shell is JavaScript: loops, functions and cursors
use labdemo
db.numbers.drop()

for (let i = 1; i <= 50; i++) {
  db.numbers.insertOne({ n: i, square: i * i, even: i % 2 === 0 })
}
db.numbers.countDocuments({ even: true })

db.numbers.find({ n: { $lte: 5 } }).forEach(doc => print(doc.n, "squared is", doc.square))

const cur = db.numbers.find({ square: { $gt: 2000 } }).sort({ n: 1 })
while (cur.hasNext()) {
  printjson(cur.next())
}

// find() shows 20 documents at a time: then run  it  to see the next 20
db.numbers.find({}, { _id: 0, n: 1, square: 1 })
`,
    },
  ];

  self.FOCT_MONGO = { DATASETS, EXAMPLES };
})();
