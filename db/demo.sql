-- Entirely invented fixture, not a real podcast transcript.
INSERT OR IGNORE INTO episodes VALUES
 ('demo-1','Fictional Demo: Lunar Kitchen','2026-01-01T00:00:00Z','https://example.com/fictional-demo/lunar-kitchen',1),
 ('demo-2','Fictional Demo: Garden Radio','2026-01-02T00:00:00Z','https://example.com/fictional-demo/garden-radio',1);
INSERT OR IGNORE INTO passages VALUES
 (1,'demo-1-p0','demo-1',0,0,10000,'FICTIONAL DEMO: A robot opened the lunar kitchen.'),
 (2,'demo-1-p1','demo-1',1,10000,20000,'FICTIONAL DEMO: The moon cheese sandwich powered a tiny rocket.'),
 (3,'demo-1-p2','demo-1',2,20000,30000,'FICTIONAL DEMO: Cheese from the moon arrived by bicycle.'),
 (4,'demo-1-p3','demo-1',3,30000,40000,'FICTIONAL DEMO: The robot closed the kitchen.'),
 (5,'demo-2-p0','demo-2',0,0,10000,'FICTIONAL DEMO: A garden robot broadcast a weather report.'),
 (6,'demo-2-p1','demo-2',1,10000,20000,'FICTIONAL DEMO: Purple carrots danced beside the radio.');
