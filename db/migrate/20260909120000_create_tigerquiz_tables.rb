class CreateTigerquizTables < ActiveRecord::Migration[8.1]
  def change
    create_table :users do |t|
      t.string :eppn, null: false           # what Shibboleth calls the person
      t.string :display_name
      t.string :role, null: false, default: "instructor"
      t.timestamps
    end
    add_index :users, :eppn, unique: true

    # A quiz is stored as the same JSON document the editor produces and the
    # quiz files use, so it round-trips without translation.
    create_table :quizzes do |t|
      t.references :user, null: false, foreign_key: true
      t.string :slug, null: false
      t.string :title, null: false
      t.json :body, null: false
      t.timestamps
    end
    add_index :quizzes, [ :user_id, :slug ], unique: true

    create_table :rosters do |t|
      t.references :user, null: false, foreign_key: true
      t.string :slug, null: false
      t.string :title, null: false
      t.json :students, null: false
      t.timestamps
    end
    add_index :rosters, [ :user_id, :slug ], unique: true

    # Games keep their UUID primary key: report links carry it.
    create_table :games, id: :string do |t|
      t.references :user, null: false, foreign_key: true
      t.references :quiz, foreign_key: { on_delete: :nullify }
      t.references :roster, foreign_key: { on_delete: :nullify }
      t.string :pin, null: false
      t.string :quiz_slug, null: false
      t.string :title, null: false
      t.datetime :started_at, null: false
      t.datetime :ended_at
      t.integer :question_count, null: false, default: 0
      t.integer :player_count, null: false, default: 0
    end
    add_index :games, [ :user_id, :started_at ]

    create_table :game_questions do |t|
      t.references :game, type: :string, null: false, foreign_key: { on_delete: :cascade }
      t.integer :idx, null: false
      t.string :question_type, null: false
      t.text :text, null: false
      t.text :answer                       # the correct answer as a label
      t.json :choices                      # for naming wrong answers
      t.text :explanation
      t.integer :source_idx                # position in the quiz, before shuffling
      t.json :correct_answer               # the machine-readable answer
    end
    add_index :game_questions, [ :game_id, :idx ], unique: true

    create_table :game_players do |t|
      t.references :game, type: :string, null: false, foreign_key: { on_delete: :cascade }
      t.string :name, null: false
      t.string :identifier
      t.integer :score, null: false, default: 0
      t.integer :rank
    end
    add_index :game_players, [ :game_id, :name ], unique: true

    create_table :game_answers do |t|
      t.references :game, type: :string, null: false, foreign_key: { on_delete: :cascade }
      t.integer :idx, null: false
      t.string :player, null: false
      t.json :response
      t.integer :ms
      t.boolean :correct
      t.integer :points, null: false, default: 0
    end
    add_index :game_answers, [ :game_id, :idx, :player ], unique: true
  end
end
